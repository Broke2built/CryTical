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
//   node sim/tournament.mjs [--scenario launch|noise|dead|mixed] [--generations 20]
//        [--ticks 600] [--seed 1] [--grid live|tight] [--out sim/tournament-brains.json] [--quiet]

import { writeFileSync } from 'node:fs';
import { __test as W } from '../worker.js';

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

export function runTournament(opts = {}) {
  const P = { ...DEFAULTS, ...opts };
  const r = rng(P.seed ?? 1);
  const babies = Array.from({ length: P.babies }, (_, i) => ({
    id: i, q: gridQTable(P.grid || 'live'), rngState: { s: (1337 + i * 7919) >>> 0 }, lineage: `b${i}`, stop: stopFor(i),
  }));
  const history = [];
  const noop = () => {};
  for (let g = 0; g < P.generations; g++) {
    const pool = new Pool(P.poolWeth, P.poolCoin, P.fee);
    const ext = { coin: P.poolCoin * 0.02, wethIn: 0, wethOut: 0, trades: 0 }; // outsiders start with a bag
    const hist = [pool.price()];
    let low = { p: pool.price(), t: 0 };
    for (const b of babies) Object.assign(b, { eth: P.bankrollEth, pos: null, lastTrade: -1e9, trades: 0, wins: 0, gas: 0 });
    const order = babies.slice();
    for (let t = 1; t <= P.ticks; t++) {
      externalFlow(P.scenario, t, P.ticks, pool, hist, r, ext, P);
      const px = pool.price();
      hist.push(px);
      if (px < low.p || t - low.t > 1440) low = { p: px, t };
      const prev = hist[hist.length - 2], prev2 = hist[hist.length - 3] ?? prev;
      const high1h = Math.max(...hist.slice(-60));
      const tickDrop = prev > px ? (prev - px) / prev * 100 : 0;
      const twoDrop = prev2 > px ? (prev2 - px) / prev2 * 100 : 0;
      const dip = (high1h - px) / high1h * 100;
      const aboveLow = (px - low.p) / low.p * 100;
      const twap = hist.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, hist.length);
      for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
      for (const b of order) {
        if (b.pos) {
          const value = pool.quoteSell(b.pos.coin);          // what selling ALL now would really fetch (impact included)
          const profit = value - b.pos.cost - P.gasEth;       // cost already includes buy gas; subtract sell gas
          const roiPct = profit / b.pos.cost * 100;
          const pc = W.parseCombo(b.pos.key);
          const target = Math.max(P.sellProfitMult * 2 * P.gasEth, b.pos.cost * pc.margin / 100);
          const held = t - b.pos.t;
          let reason = null;
          if (profit >= target) reason = 'target';
          else if (roiPct <= -P.hardStopPct) reason = 'hard-stop';
          else if (roiPct <= -b.stop.pct && held >= b.stop.holdTicks) reason = 'stop-loss';
          if (!reason || b.eth < P.gasEth) continue;
          const got = pool.sell(b.pos.coin);
          b.eth += got - P.gasEth; b.gas += P.gasEth;
          const pnl = got - b.pos.cost - P.gasEth;
          const reward = W.closeReward(pnl / b.pos.cost, held / 60);
          b.q[b.pos.key] += P.alpha * (reward - b.q[b.pos.key]);
          b.trades++; if (pnl > 0) b.wins++;
          b.pos = null; b.lastTrade = t;
          continue;
        }
        const key = W.selectCombo(b.q, b.rngState, noop, P.epsilon);
        const c = W.parseCombo(key);
        if (t - b.lastTrade < c.cd) continue;
        const crash = tickDrop >= c.dump || twoDrop >= c.dump;
        const value = dip >= c.value && tickDrop < 10 && px <= twap * 1.02;
        const bottom = aboveLow >= P.bottomMinBouncePct && aboveLow <= P.nearLowPct && (t - low.t) >= P.bottomMinLowAgeTicks;
        if (!crash && !value && !bottom) continue;
        const spend = (b.eth - 2 * P.gasEth) * c.size / 100; // keep gas for this buy AND the exit
        if (spend <= 10 * P.gasEth) continue;                 // position too small to ever clear gas
        b.eth -= spend + P.gasEth; b.gas += P.gasEth;
        b.pos = { coin: pool.buy(spend), cost: spend + P.gasEth, key, t };
      }
    }
    // Mark open positions to what they'd really fetch (impact included), sequentially.
    const finalPx = pool.price();
    const openAtEnd = babies.filter((b) => b.pos).length;
    for (const b of babies) { if (b.pos) { b.eth += pool.sell(b.pos.coin) - P.gasEth; b.gas += P.gasEth; b.pos = null; } b.pnl = b.eth - P.bankrollEth; }
    const extPnl = ext.wethOut - ext.wethIn + ext.coin * pool.price() - P.poolCoin * 0.02 * hist[0];
    const ranked = babies.slice().sort((a, b) => b.pnl - a.pnl);
    const fleetPnl = babies.reduce((a, b) => a + b.pnl, 0);
    history.push({
      gen: g, finalPx, startPx: hist[0],
      fleet: { netPnl: fleetPnl, gas: babies.reduce((a, b) => a + b.gas, 0), trades: babies.reduce((a, b) => a + b.trades, 0) },
      external: { netPnl: extPnl, trades: ext.trades }, poolFees: pool.feesWeth, openAtEnd,
      leaderboard: ranked.map((b) => ({ id: b.id, lineage: b.lineage, pnl: b.pnl, trades: b.trades, winRate: b.trades ? b.wins / b.trades : 0 })),
    });
    // Survival of the fittest: bottom `cull` replaced by mutated copies of the top `cull`.
    for (let k = 0; k < P.cull; k++) {
      const parent = ranked[k], child = ranked[ranked.length - 1 - k];
      child.q = Object.fromEntries(Object.entries(parent.q).map(([key, v]) => [key, v * (1 + (r() * 2 - 1) * P.mutation)]));
      child.lineage = `${parent.lineage}>g${g}`;
    }
  }
  return { params: P, history, brains: Object.fromEntries(babies.map((b) => [`baby_${b.id}`, { lineage: b.lineage, qtable: b.q }])) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = runTournament({ scenario: arg('--scenario', 'mixed'), generations: +arg('--generations', DEFAULTS.generations),
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
