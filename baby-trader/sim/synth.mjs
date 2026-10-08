// synth.mjs — procedural order flow learned from REAL Base swap data.
//
// ============================== NOTES FOR WREN ==============================
// What it learns, per real pool (from sim/data/real-flow-*.json, made by fetch-real.mjs):
//   rate     swaps per block
//   burst    how clustered trades are (gap coefficient of variation; >1 = bursty).
//            Real Base pools: median 1.7. Trades come in clusters, not evenly.
//   persist  P(next trade has the same direction as the last). Real: ~0.66-0.79.
//            Order flow TRENDS — buys follow buys. This is what creates the pumps and
//            dumps the babies trade, and what makes "catching the knife" dangerous.
//   impacts  the pool's own empirical |price impact| per trade (heavy tailed: the top
//            1% are ~15x the median). Sampled directly, so tails are real, not assumed.
//   drift    net direction of the window (was the coin being bought or dumped).
//
// How it generates: a self-exciting (Hawkes-style) arrival process tuned to rate+burst,
// a Markov direction chain tuned to persist, and bootstrapped impacts. Each impact is
// turned into a trade SIZE for the sim pool, so the outsiders' flow and the babies'
// own trades hit the same AMM and move the same price. That interaction is the point.
//
// Procedural variety ("domain randomization"): every generation can draw a different
// real pool profile AND jitter its parameters within real ranges, so the babies never
// see the same market twice — they have to learn trading, not memorize a chart.
//
// OVERFITTING CHECK: profiles are split into TRAIN and HOLDOUT pools. Train on train,
// score on holdout. If a brain is great on train and bad on holdout, it memorized.
// ===========================================================================

import { readdirSync, readFileSync, existsSync } from 'node:fs';

const DATA_DIR = new URL('./data/', import.meta.url).pathname;
const BLOCKS_PER_TICK = 30; // 1-minute ticks, 2s blocks

export function fitProfile(id, events) {
  const n = events.length;
  const span = Math.max(1, events[n - 1][0] - events[0][0]);
  const gaps = [];
  for (let k = 1; k < n; k++) gaps.push(events[k][0] - events[k - 1][0]);
  const mg = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mg) ** 2, 0) / Math.max(1, gaps.length));
  let same = 0, pairs = 0;
  for (let k = 1; k < n; k++) {
    const a = events[k - 1][1], b = events[k][1];
    if (a && b) { pairs++; if (Math.sign(a) === Math.sign(b)) same++; }
  }
  const impacts = Float64Array.from(events.map((e) => Math.abs(e[1])).filter((x) => x > 0).map((x) => Math.min(x, MAX_TRADE_IMPACT)));
  const buys = events.filter((e) => e[1] > 0).length;
  // Realized volatility over 30-tick (900-block) windows: the number that matters for a
  // bot. Per-trade impacts alone over-state it (bots ping-pong +x/-x, which looks like
  // big trades but nets to nothing), so the generator is scaled to match THIS.
  const W = 30 * BLOCKS_PER_TICK, buckets = new Map();
  for (const e of events) { const k = Math.floor(e[0] / W); buckets.set(k, (buckets.get(k) || 0) + e[1]); }
  const nb = Math.max(1, Math.round(span / W));
  let ss = 0; for (const v of buckets.values()) ss += v * v; // empty windows contribute 0
  const vol30 = Math.sqrt(ss / nb);
  return {
    id, swaps: n,
    rate: n / span,                                   // swaps per block
    burst: mg > 0 ? Math.max(1, sd / mg) : 1,         // gap CV, floored at Poisson
    persist: pairs ? same / pairs : 0.5,
    buyShare: n ? buys / n : 0.5,
    impacts: impacts.length ? impacts : Float64Array.of(0.001),
    vol30,
  };
}

// Dust-pool filter: in some "pools" every trade moves price 50-90% (no real liquidity).
// Nobody can trade those, and compounding their impacts blows the simulation up
// (prices x1e27). Keep pools whose 90th-percentile impact is under MAX_P90_IMPACT.
export const MAX_P90_IMPACT = 0.1;
export const MAX_TRADE_IMPACT = 0.5; // per-trade cap (log price) even for kept pools
const p90 = (a) => { const s = Array.from(a).sort((x, y) => x - y); return s[Math.floor(0.9 * (s.length - 1))] ?? 0; };

export function loadProfiles(dir = DATA_DIR, minSwaps = 40) {
  if (!existsSync(dir)) return [];
  const profiles = [];
  for (const f of readdirSync(dir).filter((x) => /^real-flow.*\.json$/.test(x)).sort()) {
    const d = JSON.parse(readFileSync(dir + f, 'utf8'));
    for (const [id, p] of Object.entries(d.pools)) {
      if (p.events.length < minSwaps) continue;
      const prof = fitProfile(`${id}@${d.toBlock}`, p.events);
      if (p90(prof.impacts) <= MAX_P90_IMPACT) profiles.push(prof);
    }
  }
  return profiles;
}

// Deterministic split: ~20% of pools never seen in training.
export function splitProfiles(profiles, holdoutFrac = 0.2) {
  const h = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); return (x >>> 0) / 4294967296; };
  return { train: profiles.filter((p) => h(p.id) >= holdoutFrac), holdout: profiles.filter((p) => h(p.id) < holdoutFrac) };
}

// Jitter a profile within real ranges (procedural variety).
export function perturb(p, r, amount = 0.5) {
  if (!amount) return p;
  const s = (lo, hi) => lo + (hi - lo) * r();
  return { ...p, id: p.id + '~', rate: p.rate * Math.exp(s(-amount, amount)), burst: Math.max(1, p.burst * Math.exp(s(-amount / 2, amount / 2))),
    persist: Math.min(0.95, Math.max(0.3, p.persist + s(-0.08, 0.08) * amount * 2)), impactScale: Math.exp(s(-amount, amount)) };
}

// Order-flow generator bound to one profile. step() returns this tick's outsider trades
// as signed log-price impacts (+ = buy).
export function makeFlow(profile, r) {
  // Hawkes-lite: intensity = mu + excitation; each trade adds `jump`, which decays per tick.
  // Branching ratio from burstiness: CV^2 ~ 1/(1-n)^2 for a Hawkes process -> n = 1 - 1/CV.
  const lam = profile.rate * BLOCKS_PER_TICK;            // mean trades per tick
  const nBranch = Math.min(0.9, Math.max(0, 1 - 1 / profile.burst));
  const mu = lam * (1 - nBranch);
  const decay = 0.5;                                     // excitation half-life ~1 tick
  const jump = nBranch * (1 - decay);
  // Variance matching: expected 30-tick variance of the generated walk is
  // N * E[imp^2] * (1+rho)/(1-rho) with N = trades per 30 ticks, rho = 2*persist-1.
  // Scale impacts so it equals the real pool's measured vol30.
  let m2 = 0; for (const x of profile.impacts) m2 += x * x; m2 /= profile.impacts.length;
  const rho = Math.min(0.9, 2 * profile.persist - 1);
  const modelVar = lam * 30 * m2 * (1 + rho) / (1 - rho);
  const match = profile.vol30 != null && modelVar > 0 ? Math.min(1, profile.vol30 / Math.sqrt(modelVar)) : 1;
  const scale = (profile.impactScale ?? 1) * match;
  let exc = 0, lastDir = r() < profile.buyShare ? 1 : -1;
  const poisson = (l) => { let k = 0, p = Math.exp(-Math.min(l, 50)), c = p, u = r(); while (u > c && k < 200) { k++; p *= l / k; c += p; } return k; };
  return {
    profile,
    step() {
      const k = poisson(mu + exc);
      exc = exc * decay;
      const out = [];
      for (let i = 0; i < k; i++) {
        lastDir = r() < profile.persist ? lastDir : -lastDir;
        const imp = profile.impacts[Math.floor(r() * profile.impacts.length)] * scale;
        out.push(lastDir * imp);
        exc += jump;
      }
      return out;
    },
  };
}

// Size a trade on a CPMM so it moves price by exp(imp). Buy: weth in; sell: coin in.
export function sizeForImpact(pool, imp) {
  const R = Math.exp(imp);
  if (imp > 0) return { side: 'buy', amount: (pool.w * (Math.sqrt(R) - 1)) / (1 - pool.fee) };
  return { side: 'sell', amount: pool.c * (1 / Math.sqrt(R) - 1) };
}
