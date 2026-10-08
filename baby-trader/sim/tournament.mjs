// tournament.mjs — 16 babies fight each other on a simulated thin AMM pool.
// Survival of the fittest: each generation the worst babies are culled and replaced
// by mutated copies of the best. Zero network, zero money, fully reproducible.
//
// ============================== NOTES FOR WREN ==============================
// WHY THIS EXISTS. Anthony wants the babies to learn real trading by fighting each
// other, and to know that THEIR OWN TRADES MOVE THE PRICE. That is the right lesson.
// It just has to be learned here (or on an anvil fork), not on a public pool: on
// mainnet, 16 wallets with one owner trading each other is wash trading no matter
// what the intent is, because outside buyers see the volume and can't tell it's
// practice. Here nobody can be misled, and you get 1000x more trades than live.
//
// WHAT IS REAL IN THIS SIM
//  * Price impact. The pool is constant-product (x*y=k) with a 1% fee, sized thin
//    like a Zora coin pool. Every baby buy pushes price up for the next baby; every
//    sell pushes it down. Babies act in a random order each tick, so being first
//    matters and nobody gets a fixed index advantage.
//  * Gas. Every tx costs GAS_ETH. With ~$0.30 bankrolls this is what kills churners.
//  * The SAME decision code as live: rewards, bandit selection, combo parsing and the
//    Q grid are imported from worker.js (__test exports). If you change the live reward,
//    the sim changes with it. Do not fork the math.
//  * External traders (scenario-dependent): noise traders, a launch-buyer wave that
//    decays, momentum chasers that buy after rallies and dump on drops.
//
// THE LESSON THE NUMBERS WILL SHOW YOU (check `fleet.netPnl` vs `external.netPnl`):
//  * Scenario "dead" (no outsiders): the fleet's TOTAL P&L is negative — exactly
//    minus fees and gas. Fleet-vs-fleet is zero-sum before costs. One baby's win is
//    another baby's loss. The tournament still ranks who is the best trader (that is
//    useful), but no money is created.
//  * Scenarios with outsiders: fleet P&L can be positive, and it comes from the
//    outsiders. That is the only real profit there is. Teach the babies to find it,
//    not to manufacture activity.
//
// MAKING TOURNAMENT BRAINS USEFUL LIVE: export with --out, then merge the way
// sim/MERGE-PLAN.md describes (rank-based small nudges, never raw overwrite — sim
// rewards are larger and cleaner than live ones).
// ===========================================================================
//
// Usage:
//   node sim/tournament.mjs [--scenario real|launch|noise|dead|mixed] [--generations 20]
//        [--ticks 600] [--seed 1] [--grid live|tight] [--out sim/tournament-brains.json] [--quiet]

import { writeFileSync } from 'node:fs';
import { __test as W } from '../worker.js';
import { makeFlow, perturb, sizeForImpact, loadProfiles } from './synth.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

export const DEFAULTS = {
  babies: 16,
  bankrollEth: 0.0001,       // ~$0.30 per baby, like live
  gasEth: 0.000002,          // per tx (~$0.006 at $3k ETH) — tune to observed Base gas
  poolWeth: 0.1,             // thin pool, like a small Zora coin
  poolCoin: 1e7,             // -> starting price 1e-8 WETH/coin
  fee: 0.01,                 // 1% per swap (Zora coin pools)
  ticks: 600,                // ticks (minutes) per generation
  generations: 20,
  cull: 4,                   // replaced per generation
  mutation: 0.15,            // relative noise on copied Q values
  epsilon: 0.10,
  alpha: 0.25,
  hardStopPct: 40,
  sellProfitMult: 1.5,
  bottomMinBouncePct: 2, nearLowPct: 10, bottomMinLowAgeTicks: 30,
};

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- constant-product pool with fee ----
export class Pool {
  constructor(weth, coin, fee) { this.w = weth; this.c = coin; this.fee = fee; this.feesWeth = 0; }
  price() { return this.w / this.c; }
  buy(wethIn) { // returns coin out
    const fee = wethIn * this.fee; const inn = wethIn - fee; this.feesWeth += fee;
    const out = (this.c * inn) / (this.w + inn); this.w += inn; this.c -= out; return out;
  }
  sell(coinIn) { // returns weth out
    const out0 = (this.w * coinIn) / (this.c + coinIn); this.c += coinIn; this.w -= out0;
    const fee = out0 * this.fee; this.feesWeth += fee; return out0 - fee;
  }
  quoteSell(coinIn) { return ((this.w * coinIn) / (this.c + coinIn)) * (1 - this.fee); }
}

// ---- external traders (scenario) ----
function externalFlow(scenario, t, ticks, pool, hist, r, ext, P) {
  const trade = (side, weth) => {
    if (side === 'buy') { const c = pool.buy(weth); ext.coin += c; ext.wethIn += weth; ext.trades++; }
    else { const c = Math.min(ext.coin, weth / pool.price()); if (c <= 0) return; ext.coin -= c; ext.wethOut += pool.sell(c); ext.trades++; }
  };
  const noise = scenario === 'noise' || scenario === 'mixed' || scenario === 'launch';
  if (noise && r() < 0.15) trade(r() < 0.5 ? 'buy' : 'sell', 0.0005 + r() * 0.002);
  if ((scenario === 'launch' || scenario === 'mixed') && r() < Math.exp(-t / (ticks / 6)) * 0.6) trade('buy', 0.001 + r() * 0.004);
  if (scenario === 'mixed' && hist.length > 15) { // momentum chasers: chase +5%/15m, dump on -5%
    const m = pool.price() / hist[hist.length - 15] - 1;
    if (m > 0.05 && r() < 0.3) trade('buy', 0.002);
    if (m < -0.05 && r() < 0.3) trade('sell', 0.002);
  }
  if (scenario === 'mixed' && r() < 0.01) trade('sell', 0.02 + r() * 0.03); // occasional whale dump
}

// Threshold grids. 'live' = worker.js today. 'tight' = the proposal in WREN-GUIDE.md:
// the live grid is so extreme (30-60% crash in 1-2 ticks, 70-90% below the 1h high)
// that it almost never fires, and a 30%+ ONE-tick crash can never be bought because
// the 20% circuit breaker halts trading first. Compare them with --grid.
export const GRIDS = {
  live: { dump: [30, 40, 50, 60], value: [70, 80, 90] },
  tight: { dump: [5, 10, 15, 20], value: [10, 20, 30] },
};
export function gridQTable(name) {
  if (name === 'live') return W.blankQTable();
  const g = GRIDS[name], q = {};
  for (const du of g.dump) for (const v of g.value) for (const m of [1, 3, 5]) for (const sz of [60, 70, 80]) for (const cd of [3, 6, 11, 20]) q[W.comboKey(du, v, m, sz, cd)] = 0;
  return q;
}

function stopFor(i) { const r = rng(1337 + i * 7919 + 13); return { pct: 14 + r() * 12, holdTicks: Math.round((1.5 + r() * 3) * 60) }; }

// ---------------------------------------------------------------------------------
// FAST ENGINE. Same rules as before, but every hot-path value is a number in a typed
// array: combo thresholds are pre-parsed once, Q is a Float64Array per baby, the 1h
// high is a monotonic deque (O(1)), TWAP is a rolling sum, and the bandit argmax is
// cached until that baby's next Q-update. Nothing allocates per tick.
// WREN: if you add a rule, keep it allocation-free in the tick loop or you lose the
// "years per minute" speed that makes the tournament worth running.
// ---------------------------------------------------------------------------------
export function comboSpace(gridName = 'live') {
  const keys = Object.keys(gridQTable(gridName)).filter((k) => Number.isFinite(W.parseCombo(k).dump));
  const n = keys.length;
  const dump = new Float64Array(n), value = new Float64Array(n), margin = new Float64Array(n),
    size = new Float64Array(n), cd = new Float64Array(n);
  keys.forEach((k, i) => { const c = W.parseCombo(k); dump[i] = c.dump; value[i] = c.value; margin[i] = c.margin; size[i] = c.size; cd[i] = c.cd; });
  return { keys, n, dump, value, margin, size, cd };
}
// Exported brains use the live table format (432 grid cells + the never-selected baseline key).
const qToObject = (cs, q) => ({ ...Object.fromEntries(cs.keys.map((k, i) => [k, q[i]])), baseline_unattributed: 0 });
const qFromObject = (cs, o) => Float64Array.from(cs.keys, (k) => o?.[k] ?? 0);

export function runTournament(opts = {}) {
  const P = { ...DEFAULTS, ...opts };
  const r = rng(P.seed ?? 1);
  const cs = opts.combos || comboSpace(P.grid || 'live');
  const NB = P.babies;
  const babies = Array.from({ length: NB }, (_, i) => ({
    id: i, q: opts.initialBrains?.[i] ? qFromObject(cs, opts.initialBrains[i].qtable) : new Float64Array(cs.n),
    lineage: opts.initialBrains?.[i]?.lineage || `b${i}`, stop: stopFor(i), best: -1,
  }));
  const history = [];
  const order = new Int32Array(NB).map((_, i) => i);
  const WIN = 60, TW = 10, MOM = 15;
  const ring = new Float64Array(WIN + 1);        // last prices (for twap/momentum/prev)
  const dqP = new Float64Array(WIN + 2), dqT = new Int32Array(WIN + 2); // monotonic deque for 1h high
  for (let g = 0; g < P.generations; g++) {
    const pool = new Pool(P.poolWeth, P.poolCoin, P.fee);
    const ext = { coin: P.poolCoin * 0.02, wethIn: 0, wethOut: 0, trades: 0 };
    // scenario 'real': outsiders follow order flow learned from a real Base pool, a
    // different (jittered) pool every generation. See sim/synth.mjs.
    const flow = P.scenario === 'real' && P.profiles?.length
      ? makeFlow(perturb(P.profiles[Math.floor(r() * P.profiles.length)], r, P.perturb ?? 0.5), r) : null;
    const p0 = pool.price();
    ring.fill(p0);
    let head = 0, dqH = 0, dqTl = 0, twSum = p0 * TW, lowP = p0, lowT = 0;
    const histView = { length: 0, at: (back) => ring[(head - back + 1 + 2 * (WIN + 1)) % (WIN + 1)] };
    for (const b of babies) { b.eth = P.bankrollEth; b.pos = false; b.coin = 0; b.cost = 0; b.key = -1; b.t0 = 0; b.lastTrade = -1e9; b.trades = 0; b.wins = 0; b.gas = 0; }
    for (let t = 1; t <= P.ticks; t++) {
      histView.length = t;
      if (flow) {
        const imps = flow.step();
        for (let k = 0; k < imps.length; k++) {
          const { side, amount } = sizeForImpact(pool, Math.max(-1, Math.min(1, imps[k])));
          if (!(amount > 0)) continue;
          if (side === 'buy') { ext.coin += pool.buy(amount); ext.wethIn += amount; }
          else { ext.coin -= amount; ext.wethOut += pool.sell(amount); } // outsiders = the whole market; may go net short
          ext.trades++;
        }
      } else externalFlowFast(P.scenario, t, P.ticks, pool, histView, r, ext);
      const px = pool.price();
      const prev = ring[head], prev2 = ring[(head + WIN) % (WIN + 1)];
      const out = ring[(head + 1 + (WIN + 1) - TW) % (WIN + 1)];
      head = (head + 1) % (WIN + 1); ring[head] = px;
      twSum += px - out;
      while (dqTl > dqH && dqP[(dqTl - 1) % (WIN + 2)] <= px) dqTl--;
      dqP[dqTl % (WIN + 2)] = px; dqT[dqTl % (WIN + 2)] = t; dqTl++;
      while (dqT[dqH % (WIN + 2)] <= t - WIN) dqH++;
      const high1h = dqP[dqH % (WIN + 2)];
      if (px < lowP || t - lowT > 1440) { lowP = px; lowT = t; }
      const tickDrop = prev > px ? (prev - px) / prev * 100 : 0;
      const twoDrop = prev2 > px ? (prev2 - px) / prev2 * 100 : 0;
      const dip = (high1h - px) / high1h * 100;
      const aboveLow = (px - lowP) / lowP * 100;
      const belowTwap = px <= (twSum / TW) * 1.02;
      const p5 = ring[(head + (WIN + 1) - 5) % (WIN + 1)];
      const mom5 = (px / p5 - 1) * 100;
      const bottom = aboveLow >= P.bottomMinBouncePct && aboveLow <= P.nearLowPct && (t - lowT) >= P.bottomMinLowAgeTicks;
      for (let k = NB - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); const x = order[k]; order[k] = order[j]; order[j] = x; }
      // ANTI-STALEMATE experiment (P.onePerTick): at most ONE baby may open a position per
      // tick on this coin (random order = rotating turn). Without it, all 16 read the same
      // price, fire the same signal in the same tick, buy together and freeze together.
      let boughtThisTick = false;
      for (let oi = 0; oi < NB; oi++) {
        const b = babies[order[oi]];
        if (b.pos) {
          const profit = pool.quoteSell(b.coin) - b.cost - P.gasEth;
          const roiPct = profit / b.cost * 100;
          const target = Math.max(P.sellProfitMult * 2 * P.gasEth, b.cost * cs.margin[b.key] / 100);
          const held = t - b.t0;
          if (!(profit >= target || roiPct <= -P.hardStopPct || (roiPct <= -b.stop.pct && held >= b.stop.holdTicks)) || b.eth < P.gasEth) continue;
          const got = pool.sell(b.coin);
          b.eth += got - P.gasEth; b.gas += P.gasEth;
          const pnl = got - b.cost - P.gasEth;
          const reward = W.closeReward(pnl / b.cost, held / 60);
          b.q[b.key] += P.alpha * (reward - b.q[b.key]);
          b.best = -1; b.trades++; if (pnl > 0) b.wins++;
          b.pos = false; b.lastTrade = t;
          continue;
        }
        let key;
        if (r() < P.epsilon) key = Math.floor(r() * cs.n);
        else {
          if (b.best < 0) { // argmax with random tie-break (reservoir), cached until next update
            let bv = -Infinity, cnt = 0;
            for (let i = 0; i < cs.n; i++) { const v = b.q[i]; if (v > bv) { bv = v; b.best = i; cnt = 1; } else if (v === bv && r() * ++cnt < 1) b.best = i; }
          }
          key = b.best;
        }
        if (t - b.lastTrade < cs.cd[key]) continue;
        if (P.onePerTick && boughtThisTick) continue;
        const d = cs.dump[key];
        // P.strategy: 'dip' (live worker.js logic), 'momentum' (buy WITH a rise of >= dump%
        // over 5 ticks — real Base order flow persists ~70% of the time), or 'both'.
        const dipSig = tickDrop >= d || twoDrop >= d || (dip >= cs.value[key] && tickDrop < 10 && belowTwap) || bottom;
        const momSig = mom5 >= d && px < high1h * 1.0001; // rising and at/near the 1h high
        const strat = P.strategy || 'dip';
        if (!(strat === 'dip' ? dipSig : strat === 'momentum' ? momSig : dipSig || momSig)) continue;
        const spend = (b.eth - 2 * P.gasEth) * cs.size[key] / 100;
        if (spend <= 10 * P.gasEth) continue;
        b.eth -= spend + P.gasEth; b.gas += P.gasEth;
        b.coin = pool.buy(spend); b.cost = spend + P.gasEth; b.key = key; b.t0 = t; b.pos = true; boughtThisTick = true;
      }
    }
    const finalPx = pool.price();
    let openAtEnd = 0;
    for (const b of babies) { if (b.pos) { openAtEnd++; b.eth += pool.sell(b.coin) - P.gasEth; b.gas += P.gasEth; b.pos = false; } b.pnl = b.eth - P.bankrollEth; }
    const extPnl = ext.wethOut - ext.wethIn + ext.coin * pool.price() - P.poolCoin * 0.02 * p0;
    const ranked = babies.slice().sort((a, b) => b.pnl - a.pnl);
    let fleetPnl = 0, gas = 0, trades = 0;
    for (const b of babies) { fleetPnl += b.pnl; gas += b.gas; trades += b.trades; }
    if (!P.lean || g === P.generations - 1) history.push({
      gen: g, finalPx, startPx: p0, fleet: { netPnl: fleetPnl, gas, trades },
      external: { netPnl: extPnl, trades: ext.trades }, poolFees: pool.feesWeth, openAtEnd,
      leaderboard: ranked.map((b) => ({ id: b.id, lineage: b.lineage, pnl: b.pnl, trades: b.trades, winRate: b.trades ? b.wins / b.trades : 0 })),
    });
    else history.push({ gen: g, fleet: { netPnl: fleetPnl, gas, trades }, external: { netPnl: extPnl, trades: ext.trades } });
    // Survival of the fittest: bottom `cull` replaced by mutated copies of the top `cull`.
    for (let k = 0; k < P.cull; k++) {
      const parent = ranked[k], child = ranked[NB - 1 - k];
      for (let i = 0; i < cs.n; i++) child.q[i] = parent.q[i] * (1 + (r() * 2 - 1) * P.mutation);
      child.lineage = parent.lineage.length > 200 ? parent.lineage.slice(0, 12) + '…' : `${parent.lineage}>g${g}`;
      child.best = -1;
    }
  }
  return { params: P, history, brains: Object.fromEntries(babies.map((b) => [`baby_${b.id}`, { lineage: b.lineage, qtable: qToObject(cs, b.q) }])) };
}

// Same outsider model as externalFlow, reading prices from the ring buffer.
function externalFlowFast(scenario, t, ticks, pool, hist, r, ext) {
  if (scenario === 'dead') return;
  const trade = (side, weth) => {
    if (side === 'buy') { ext.coin += pool.buy(weth); ext.wethIn += weth; ext.trades++; }
    else { const c = Math.min(ext.coin, weth / pool.price()); if (c <= 0) return; ext.coin -= c; ext.wethOut += pool.sell(c); ext.trades++; }
  };
  if (r() < 0.15) trade(r() < 0.5 ? 'buy' : 'sell', 0.0005 + r() * 0.002);
  if ((scenario === 'launch' || scenario === 'mixed') && r() < Math.exp(-t / (ticks / 6)) * 0.6) trade('buy', 0.001 + r() * 0.004);
  if (scenario === 'mixed' && hist.length > 15) {
    const m = pool.price() / hist.at(15) - 1;
    if (m > 0.05 && r() < 0.3) trade('buy', 0.002);
    if (m < -0.05 && r() < 0.3) trade('sell', 0.002);
  }
  if (scenario === 'mixed' && r() < 0.01) trade('sell', 0.02 + r() * 0.03);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const scenario = arg('--scenario', 'mixed');
  const profiles = scenario === 'real' ? loadProfiles() : undefined;
  if (scenario === 'real' && !profiles.length) { console.error('no real data: run node sim/fetch-real.mjs first'); process.exit(2); }
  const res = runTournament({ scenario, profiles, generations: +arg('--generations', DEFAULTS.generations),
    ticks: +arg('--ticks', DEFAULTS.ticks), seed: +arg('--seed', 1), grid: arg('--grid', 'live') });
  const ETH_USD = +(process.env.ETH_USD || 3000), usd = (e) => `$${(e * ETH_USD).toFixed(3)}`;
  for (const h of res.history) {
    if (args.includes('--quiet') && h.gen !== res.history.length - 1) continue;
    const top = h.leaderboard.slice(0, 3).map((b) => `b${b.id}(${b.lineage.split('>')[0]}) ${usd(b.pnl)} ${b.trades}t ${(b.winRate * 100).toFixed(0)}%`).join(' | ');
    console.log(`gen ${String(h.gen).padStart(2)}: fleet ${usd(h.fleet.netPnl)} (${h.fleet.trades} closes, ${h.openAtEnd} stuck open, gas ${usd(h.fleet.gas)}) | outsiders ${usd(h.external.netPnl)} | price x${(h.finalPx / h.startPx).toFixed(2)} | top: ${top}`);
  }
  const out = arg('--out', null);
  if (out) { writeFileSync(out, JSON.stringify(res.brains)); console.log(`brains -> ${out} (SIM-ONLY: merge per MERGE-PLAN.md, never overwrite live)`); }
}
