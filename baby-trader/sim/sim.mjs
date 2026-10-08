// sim.mjs — baby-trader battle simulator (Anthony order 2026-10-08 09:30 EDT)
// Replays real BRAWL/SLIPPY price history through 16 agents seeded from the
// LIVE babies' Q-tables. Teaches: first-buyer edge, momentum entry, role diversity.
// Read-only toward chain/money: zero broadcasts, zero real trades.
// Reviewed 2026-10-08 (two-pass, self): math mirrors worker.js recordClose/
// selectCombo/walletStopLoss; divergences listed below.
//
// SIM-DIVERGENCES (vs worker.js):
// 1. No NN (buy veto / sizing / sell head). Bandit combo only.
// 2. No market impact: 16 agents on one replay do not move price.
// 3. No gas: live target = profit >= 1.5x gas; sim target = combo margin% ROI.
//    Fees modeled as flat 1% per side.
// 4. Fixed epsilon per role (live: adaptive via arena:avgReward).
// 5. No spike-sell pre-pass, no SELL-INTO-ANTHONY, no max-hold. Stop-loss is the
//    discipline exit; window-end forces close so every episode yields Q-updates.
// 6. Momentum buy signal is NEW (worker.js lacks it) — Anthony-ordered lesson.
// 7. First-jumper launch-rush is NEW (role overlay, not in Q grid).
// 8. Exploit-pick caching: live re-scans 432 keys per tick; sim caches the argmax
//    and recomputes only after a Q-update (identical argmax; tie re-roll per
//    Q-update instead of per tick — negligible).

// ============================== NOTES FOR WREN (review 2026-10-08) ==============================
// Read before trusting sim-report.md. The "patient wins 3:1 / crash-dip is THE edge"
// finding is built on these problems, now fixed or measured:
//  1. REWARD: losses were divided by (1+holdHours), so slow losers looked good. Now
//     uses worker.js closeReward (same fix as live).
//  2. STOP-LOSS: only fired after 1.5-4.5h held; a -60% position in minute 3 rode on.
//     Now the 40% hard stop applies at any time (same as live).
//  3. NO GAS: live needs profit >= 1.5x gas; on ~$0.30 positions that is a ~10-15%
//     move, not the 1-5% margin the sim used. SIM_GAS_USD (default $0.006/tx) now
//     charges gas and the exit bar is max(1.5x round-trip gas, margin) — same as live.
//  4. BOTTOM signal: same falling-knife fix as live (held low + bounce).
//  5. OVERFITTING: 5000 episodes over ~725 price points replays the SAME few crash
//     events thousands of times. The sim now prints how many UNIQUE entry ticks each
//     signal used. If "crash" has 8 unique entries, the $0.26-0.34/trade edge is 8
//     data points, not 235k trades. Trust unique counts, not trade counts.
//  6. Paths were hard-coded to /home/hatch. Now SIM_DIR / SIM_KV env vars.
// Fleet-vs-fleet dynamics (babies moving the price for each other) live in
// sim/tournament.mjs — this file is a replay of real history.
// ================================================================================================
import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { __test as W } from '../worker.js';

const SIM_DIR = process.env.SIM_DIR || dirname(fileURLToPath(import.meta.url));
const SIM_KV = process.env.SIM_KV || '/home/hatch/workspace/cloudflare/slippy-trader/local-runner/kv-store.json';
const GAS_USD = Number(process.env.SIM_GAS_USD ?? 0.006);
const HARD_STOP_PCT = 40, BOTTOM_MIN_BOUNCE_PCT = 2, BOTTOM_MIN_LOW_AGE_MS = 30 * 60e3, SELL_PROFIT_MULT = 1.5;
const FEE = 0.01;
const SIM_BALANCE = 1.0;
const BLIND_DT_MS = 10 * 60e3;
const MOMENTUM_TH = 8;
const WINDOW = { SLIPPY: 300, BRAWL: 120 };
const EPISODES = Number(process.env.SIM_EPISODES || 5000);
const COIN_P = { SLIPPY: 0.75, BRAWL: 0.25 };
const SLIP_K = 0.04;              // own-trade slippage: $1 buy => +4% on your fill (thin pool)
const IMPACT_K = 0.01;            // others' trades: $1 => 1% transient shared impact
const IMPACT_HALF_MS = 30 * 60e3; // shared impact half-life 30min
const IMPACT_CAP = 0.08;          // hard cap ±8% — prevents feedback spirals

const DUMP_GRID = [30, 40, 50, 60];
const VALUE_GRID = [70, 80, 90];
const MARGIN_GRID = [1, 3, 5];
const SIZE_GRID = [60, 70, 80];
const CD_GRID = [3, 6, 11, 20];
const ALPHA = 0.25;
const STABLE_MAX_DROP_PCT = 10;
const NEAR_LOW_PCT = 10;
const BASELINE_UNATTRIBUTED_KEY = 'baseline_unattributed';
const SEED_BASE = 1337, SEED_STEP = 7919;

function rngNext(st) {
  let s = st.s | 0;
  s = (s + 0x6D2B79F5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  st.s = s;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function walletStopLoss(i) {
  const st = { s: (SEED_BASE + i * 7919 + 13) >>> 0 };
  return { pct: 14 + rngNext(st) * 12, holdMs: (1.5 + rngNext(st) * 3) * 3600e3 };
}
const parseCombo = (k) => {
  const parts = String(k).split('_'), nums = parts.map(Number);
  let cd = 11;
  if (parts.length >= 5) { const m = /^cd(\d+(?:\.\d+)?)$/.exec(parts[4]); if (m) cd = Number(m[1]); }
  return { dump: nums[0], value: nums[1], margin: nums[2], size: (nums[3] || 70), cd };
};
function finiteKeys(qtable) {
  const keys = Object.keys(qtable).filter((k) => {
    const p = parseCombo(k);
    return Number.isFinite(p.dump) && Number.isFinite(p.value) && Number.isFinite(p.margin) && Number.isFinite(p.size);
  });
  return keys.length ? keys : Object.keys(qtable);
}
function exploitPick(qtable, keys, rng) {
  let bestV = -Infinity; const tied = [];
  for (const k of keys) {
    const v = qtable[k] ?? 0;
    if (v > bestV) { bestV = v; tied.length = 0; tied.push(k); }
    else if (v === bestV) tied.push(k);
  }
  return tied[Math.floor(rngNext(rng) * tied.length)];
}
function recordCloseMath(profitUsd, costUsd, holdHours) {
  const roi = costUsd > 0 ? profitUsd / costUsd : 0;
  const hh = Math.max(holdHours, 1 / 3600);
  return { roi, hh, baseReward: W.closeReward(roi, hh) }; // shared with live (no loss discount)
}

const ROLES = [
  ...[0, 1, 2, 3].map(i => ({ i, name: 'first-jumper', epsilon: 0.35, rush: true, momentum: true })),
  ...[4, 5, 6, 7, 8, 9].map(i => ({ i, name: 'momentum', epsilon: 0.15, rush: false, momentum: true })),
  ...[10, 11, 12, 13, 14, 15].map(i => ({ i, name: 'patient', epsilon: 0.10, rush: false, momentum: false })),
];

// deterministic sim RNG (episode sampling, shuffles)
const simRng = { s: 0xC10C >>> 0 };
const srand = () => rngNext(simRng);

const replay = JSON.parse(readFileSync(`${SIM_DIR}/replay-data.json`, 'utf8'));
function precompute(coin) {
  const pts = replay.coins[coin].points, n = pts.length, F = new Array(n);
  for (let j = 0; j < n; j++) {
    const p = pts[j].p, t = pts[j].t;
    const prev = j > 0 ? pts[j - 1] : null, prev2 = j > 1 ? pts[j - 2] : null;
    const tickDropPct = prev && prev.p > p ? (prev.p - p) / prev.p * 100 : 0;
    const twoTickDropPct = prev2 && prev2.p > p ? (prev2.p - p) / prev2.p * 100 : 0;
    let high = p;
    for (let k = j; k >= 0 && pts[k].t >= t - 3600e3; k--) if (pts[k].p > high) high = pts[k].p;
    const dPct = high > 0 ? (high - p) / high * 100 : 0;
    let low = p, lowT = t;
    for (let k = j; k >= 0 && pts[k].t >= t - 86400e3; k--) if (pts[k].p < low) { low = pts[k].p; lowT = pts[k].t; }
    const aboveLowPct = low > 0 ? (p - low) / low * 100 : Infinity;
    const lowAgeMs = t - lowT;
    let tw = 0, twt = 0;
    for (let k = j; k >= 0 && pts[k].t >= t - 600e3; k--) {
      const kPrevT = k > 0 ? pts[k - 1].t : pts[k].t;
      const dt = Math.min(pts[k].t, t) - Math.max(kPrevT, t - 600e3);
      if (dt > 0) { tw += pts[k].p * dt; twt += dt; }
    }
    const twap = twt > 0 ? tw / twt : p;
    const m15 = j >= 15 && pts[j - 15].p > 0 ? (p - pts[j - 15].p) / pts[j - 15].p * 100 : 0;
    F[j] = { tickDropPct, twoTickDropPct, dPct, aboveLowPct, lowAgeMs, belowTwap: p <= twap * 1.02, momentum15: m15,
             blind: prev ? (t - prev.t) > BLIND_DT_MS : false };
  }
  return { pts, F };
}
const DATA = { BRAWL: precompute('BRAWL'), SLIPPY: precompute('SLIPPY') };

// live Q-tables, READ-ONLY source
const kv = JSON.parse(readFileSync(SIM_KV, 'utf8'));
const liveQ = [];
for (let i = 0; i < 16; i++) {
  const raw = kv[`wallet:${i}:qtable`];
  liveQ.push(raw ? JSON.parse(raw) : {});
  if (!Object.keys(liveQ[i]).length) throw new Error(`wallet ${i} qtable missing/empty — refusing to sim on blank tables`);
}

// persistent agents: Q-tables evolve across episodes; balance/position reset per episode
const agents = ROLES.map(r => {
  const sl = walletStopLoss(r.i);
  const keys = finiteKeys(liveQ[r.i]);
  return { ...r, q: JSON.parse(JSON.stringify(liveQ[r.i])), keys,
    rng: { s: (SEED_BASE + r.i * SEED_STEP + 999) >>> 0 },
    cachedBest: null, slPct: sl.pct, slHoldMs: sl.slHoldMs ?? sl.holdMs,
    // cumulative stats
    trades: 0, wins: 0, pnl: 0, firstBuys: 0, firstBuyPnl: 0, firstBuyTrades: 0,
    entryIdxSum: 0, firstEntryIdxSum: 0, signalStats: {} };
});
function pickCombo(a) { // epsilon-greedy with exploit cache
  if (rngNext(a.rng) < a.epsilon) return a.keys[Math.floor(rngNext(a.rng) * a.keys.length)];
  if (!a.cachedBest) a.cachedBest = exploitPick(a.q, a.keys, a.rng);
  return a.cachedBest;
}
function qUpdate(a, key, baseReward) {
  const oldQ = a.q[key] ?? 0;
  a.q[key] = oldQ + ALPHA * (baseReward - oldQ);
  a.cachedBest = null; // invalidate exploit cache
}

function runEpisode(coin, s) {
  const { pts, F } = DATA[coin], W = WINDOW[coin], e = Math.min(s + W, pts.length);
  for (const a of agents) { a.balance = SIM_BALANCE; a.pos = null; a.lastTradeT = -Infinity; }
  let firstBuyDone = false;
  let impact = 0; // shared pool impact: buys push up, sells push down, decays
  const order = agents.slice();
  // Signals evaluated at tick j, FILLED at tick j+1 (no lookahead: you cannot
  // trade at a printed price; your tx lands on the next print).
  for (let j = s; j < e - 1; j++) {
    const f = F[j], price = pts[j].p, t = pts[j].t;
    if (f.blind || !(price > 0)) continue;
    const dtMs = pts[j + 1].t - pts[j].t;
    impact *= Math.pow(0.5, Math.max(dtMs, 0) / IMPACT_HALF_MS);
    if (impact > IMPACT_CAP) impact = IMPACT_CAP; else if (impact < -IMPACT_CAP) impact = -IMPACT_CAP;
    const mktNext = pts[j + 1].p, fpt = pts[j + 1].t;
    if (!(mktNext > 0)) continue;
    // shuffle agent order per tick (no index advantage)
    for (let k = order.length - 1; k > 0; k--) { const r = Math.floor(srand() * (k + 1)); [order[k], order[r]] = [order[r], order[k]]; }
    for (const a of order) {
      if (a.pos) {
        const effSellPx = price * (1 + impact); // what a market sell would actually get
        const grossSig = a.pos.tokens * effSellPx * (1 - FEE);
        const profitSig = grossSig - a.pos.cost - 2 * GAS_USD; // buy gas + sell gas
        const roiPct = a.pos.cost > 0 ? profitSig / a.pos.cost * 100 : 0;
        const heldMs = t - a.pos.buyT;
        const pc = parseCombo(a.pos.comboKey);
        const targetUsd = Math.max(SELL_PROFIT_MULT * 2 * GAS_USD, a.pos.cost * pc.margin / 100);
        let reason = null;
        if (profitSig >= targetUsd) reason = 'target';
        else if (roiPct <= -HARD_STOP_PCT) reason = 'hard-stop';
        else if (roiPct <= -a.slPct && heldMs >= a.slHoldMs) reason = 'stop-loss';
        if (!reason) continue;
        const grossEst = a.pos.tokens * mktNext * (1 + impact);
        const gross = grossEst * (1 - SLIP_K * grossEst) * (1 - FEE); // own-size slippage on the way out
        const profit = gross - a.pos.cost - 2 * GAS_USD;
        a.balance += gross - GAS_USD;
        impact -= grossEst * IMPACT_K; // sells push price down for everyone after
        const { roi, hh, baseReward } = recordCloseMath(profit, a.pos.cost, (fpt - a.pos.buyT) / 3600e3);
        qUpdate(a, a.pos.comboKey, baseReward);
        a.trades++; a.pnl += profit;
        if (profit > 0) a.wins++;
        const sig = a.pos.signal;
        const ss = a.signalStats[sig] || (a.signalStats[sig] = { trades: 0, pnl: 0, wins: 0 });
        ss.trades++; ss.pnl += profit; if (profit > 0) ss.wins++; (ss.uniq || (ss.uniq = {}))[a.pos.entryKey] = 1;
        a.entryIdxSum += a.pos.entryIdx;
        if (a.pos.firstBuyer) { a.firstBuys++; a.firstBuyPnl += profit; a.firstBuyTrades++; a.firstEntryIdxSum += a.pos.entryIdx; }
        a.pos = null; a.lastTradeT = fpt;
      } else {
        const ck = pickCombo(a);
        const pc = parseCombo(ck);
        if (t - a.lastTradeT < pc.cd * 60e3) continue;
        if (a.balance < 0.05) continue;
        const crashBuy = f.tickDropPct >= pc.dump || f.twoTickDropPct >= pc.dump;
        const valueBuy = f.dPct >= pc.value && f.tickDropPct < STABLE_MAX_DROP_PCT && f.belowTwap;
        const bottomBuy = f.aboveLowPct >= BOTTOM_MIN_BOUNCE_PCT && f.aboveLowPct <= NEAR_LOW_PCT && f.lowAgeMs >= BOTTOM_MIN_LOW_AGE_MS;
        const momentumBuy = a.momentum && f.momentum15 >= MOMENTUM_TH && f.tickDropPct < STABLE_MAX_DROP_PCT;
        const rushBuy = a.rush && (j - s) < 15;
        const sig = crashBuy ? 'crash' : valueBuy ? 'value' : bottomBuy ? 'bottom' : momentumBuy ? 'momentum' : rushBuy ? 'rush' : null;
        if (!sig) continue;
        const cost = (a.balance - 2 * GAS_USD) * (pc.size / 100);
        if (cost <= 10 * GAS_USD) continue; // can never clear gas
        a.balance -= GAS_USD; // buy gas
        const buyPx = mktNext * (1 + impact) * (1 + SLIP_K * cost); // own-size slippage on the way in
        const tokens = cost * (1 - FEE) / buyPx;
        a.balance -= cost;
        impact += cost * IMPACT_K; // buys push price up for everyone after
        a.pos = { comboKey: ck, cost, buyT: fpt, tokens, signal: sig, firstBuyer: !firstBuyDone, entryIdx: j - s, entryKey: `${coin}:${j}` };
        if (!firstBuyDone) firstBuyDone = true;
      }
    }
  }
  // force-close survivors at the final print (window-end)
  const lpx = pts[e - 1].p * (1 + impact), lpt = pts[e - 1].t;
  if (lpx > 0) for (const a of agents) {
    if (!a.pos) continue;
    const grossEst = a.pos.tokens * lpx;
    const gross = grossEst * (1 - SLIP_K * grossEst) * (1 - FEE);
    const profit = gross - a.pos.cost - 2 * GAS_USD;
    a.balance += gross - GAS_USD;
    const { roi, hh, baseReward } = recordCloseMath(profit, a.pos.cost, (lpt - a.pos.buyT) / 3600e3);
    qUpdate(a, a.pos.comboKey, baseReward);
    a.trades++; a.pnl += profit;
    if (profit > 0) a.wins++;
    const sig = a.pos.signal;
    const ss = a.signalStats[sig] || (a.signalStats[sig] = { trades: 0, pnl: 0, wins: 0 });
    ss.trades++; ss.pnl += profit; if (profit > 0) ss.wins++; (ss.uniq || (ss.uniq = {}))[a.pos.entryKey] = 1;
    a.entryIdxSum += a.pos.entryIdx;
    if (a.pos.firstBuyer) { a.firstBuys++; a.firstBuyPnl += profit; a.firstBuyTrades++; a.firstEntryIdxSum += a.pos.entryIdx; }
    a.pos = null; a.lastTradeT = lpt;
  }
}

const tStart = Date.now();
for (let ep = 0; ep < EPISODES; ep++) {
  const coin = srand() < COIN_P.SLIPPY ? 'SLIPPY' : 'BRAWL';
  const { pts } = DATA[coin], W = WINDOW[coin];
  const maxS = pts.length - W - 1;
  let s;
  if (coin === 'SLIPPY' && srand() < 0.35) s = Math.floor(srand() * Math.min(90, maxS));
  else s = Math.floor(srand() * maxS);
  runEpisode(coin, s);
  if ((ep + 1) % 1000 === 0) console.error(`... ${ep + 1}/${EPISODES} (${((Date.now() - tStart) / 1000).toFixed(0)}s)`);
}

// ---- persist ----
const qOut = {};
for (const a of agents) qOut[`wallet:${a.i}:qtable`] = JSON.stringify(a.q);
writeFileSync(`${SIM_DIR}/sim-qtables.json`, JSON.stringify(qOut));
const roleAgg = {};
for (const a of agents) {
  const ra = roleAgg[a.name] || (roleAgg[a.name] = { wallets: [], trades: 0, wins: 0, pnl: 0, firstBuys: 0, firstBuyPnl: 0, avgEntryIdx: 0, avgFirstEntryIdx: 0, signalStats: {} });
  ra.wallets.push(a.i); ra.trades += a.trades; ra.wins += a.wins; ra.pnl += a.pnl;
  ra.firstBuys += a.firstBuys; ra.firstBuyPnl += a.firstBuyPnl;
  ra.avgEntryIdx += a.entryIdxSum; ra.avgFirstEntryIdx += a.firstEntryIdxSum;
  for (const [sig, st] of Object.entries(a.signalStats)) {
    const rs = ra.signalStats[sig] || (ra.signalStats[sig] = { trades: 0, pnl: 0, wins: 0, uniqueEntries: 0, _u: {} });
    rs.trades += st.trades; rs.pnl += st.pnl; rs.wins += st.wins;
    Object.assign(rs._u, st.uniq || {}); rs.uniqueEntries = Object.keys(rs._u).length;
  }
}
for (const ra of Object.values(roleAgg)) {
  for (const rs of Object.values(ra.signalStats)) delete rs._u;
  ra.avgEntryIdx = ra.trades ? +(ra.avgEntryIdx / ra.trades).toFixed(1) : 0;
  ra.avgFirstEntryIdx = ra.firstBuys ? +(ra.avgFirstEntryIdx / ra.firstBuys).toFixed(1) : 0;
}
writeFileSync(`${SIM_DIR}/sim-agg.json`, JSON.stringify(
  { episodes: EPISODES, ranAt: new Date().toISOString(), ms: Date.now() - tStart, roleAgg }, null, 1));
console.error(`done ${EPISODES} episodes in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
for (const [name, ra] of Object.entries(roleAgg)) {
  const wr = ra.trades ? (ra.wins / ra.trades * 100).toFixed(1) : '-';
  const fbwr = ra.firstBuys ? (ra.firstBuyPnl / ra.firstBuys) : 0;
  for (const [sig, st] of Object.entries(ra.signalStats)) console.error(`   ${sig}: ${st.trades} trades from ${st.uniqueEntries} UNIQUE entry ticks, $${(st.pnl / Math.max(1, st.trades)).toFixed(3)}/trade, win ${(st.wins / Math.max(1, st.trades) * 100).toFixed(0)}%`);
  console.error(`${name}: trades=${ra.trades} winRate=${wr}% pnl=$${ra.pnl.toFixed(2)} firstBuys=${ra.firstBuys} avgFirstBuyPnl=$${fbwr.toFixed(4)} avgEntryIdx=${ra.avgEntryIdx}`);
}
