// fleet-dryrun.mjs — dry-run the fleet-wide baby trader WITHOUT touching live wallets.
//
// 16 babies read the shared market snapshot (market-watcher.mjs) and make buy
// decisions with ZERO per-baby network calls for market data (audited below).
//
// ============================== NOTES FOR WREN ==============================
// FRESH COINS and DEAD COINS — the "initial entry" problem. The honest answer:
//
//   A baby can only profit if someone ELSE takes the other side. On a fresh or dead
//   coin the question is never "how do we get it moving" — it is "is anyone already
//   here". So the entry rules below require EXTERNAL flow (traders that are not our
//   wallets; see tape.external* in market-watcher.mjs):
//
//   FRESH COIN (no history):
//     - Wait for the launch spike to be printed by OTHER people. No history = no
//       signal; the old "rush in first" idea is the sim's weakest edge ($0.11/trade)
//       and on a live chart our 16 wallets would BE the launch volume.
//     - LAUNCH-PULLBACK: price 20-30% below the launch high, stable this tick, AND at
//       least MIN_EXTERNAL_BUYERS distinct external buyers in the last ~10 min. That is
//       "people want this coin and it just got cheaper", which is a real setup.
//     - Size it as a probe (PROBE_SIZE_PCT). One baby per coin per tick. The 2x-gas
//       exit bar still applies, so a probe on a $0.05 position is usually not worth it —
//       check `positionUsd > 20 * gasUsd` before entering.
//   DEAD COIN (flat, nobody trading):
//     - Do NOT trade it. A dead coin with zero external swaps has no buyers to sell to.
//       The only trades available are baby-vs-baby, which on a public pool is wash
//       trading no matter how "competitive" the babies are. assignment.mjs gives dead
//       coins 0 babies; this file returns no signals for them.
//     - If you want the babies to learn by fighting each other, do it in
//       sim/tournament.mjs (or on an anvil fork of Base). Same skills, nobody misled.
//   COLD START (coin newly added to the watchlist):
//     - firstSeenTs is when the WATCHER first saw the coin, not when it launched.
//       Restarting the watcher with an empty snapshot makes every coin look "fresh".
//       Prefer the real launch time from the Zora API / pool init block.
//     - VALUE/BOTTOM are gated on historyReady (>=10 ticks).
// ===========================================================================
//
// Usage: node fleet-dryrun.mjs [--snapshot path] [--watchlist path]

import { readFileSync, existsSync } from 'node:fs';
import { computeAssignment } from './assignment.mjs';

export const DUMP_THRESHOLD = 40;        // crash buy (mid grid value)
export const VALUE_THRESHOLD = 80;       // dip from 1h high (mid grid value)
export const NEAR_LOW_PCT = 10;          // bottom buy: at most 10% off the 24h low...
export const BOTTOM_MIN_BOUNCE_PCT = 2;  // ...but at least 2% off it (not AT a fresh low)
export const BOTTOM_MIN_LOW_AGE_MS = 30 * 60e3; // and the low has held 30 min
export const LAUNCH_PULLBACK_MIN = 20;
export const LAUNCH_PULLBACK_MAX = 30;
export const LAUNCH_AGE_HOURS = 24;
export const MIN_EXTERNAL_BUYERS = 3;    // fresh-coin entry needs real demand
export const PROBE_SIZE_PCT = 25;        // fresh-coin entries are probes, not full size

export function evaluateSignals(coinSnap, now = Date.now()) {
  const signals = [];
  const sq = BigInt(coinSnap.priceSq || 0);
  if (sq <= 0n) return { signals, reason: 'no price' };
  const tape = coinSnap.tape || {};
  if (coinSnap.dead || (coinSnap.externalSwaps1h ?? 0) === 0) {
    return { signals, reason: 'no external market (dead) — do not trade; practice in the sim/fork' };
  }
  const highSq = BigInt(coinSnap.high1hSq), lowSq = BigInt(coinSnap.low24hSq);
  const tickDropPct = coinSnap.moveBps < 0 ? -coinSnap.moveBps / 100 : 0;
  let twoTickDropPct = 0;
  const b = coinSnap.buckets || [];
  if (b.length >= 3) { const b0 = BigInt(b[b.length - 3].sq); if (b0 > sq) twoTickDropPct = Number(((b0 - sq) * 10000n) / b0) / 100; }
  const stable = tickDropPct < 10;
  if (tickDropPct >= DUMP_THRESHOLD || twoTickDropPct >= DUMP_THRESHOLD) {
    signals.push({ type: 'CRASH', detail: `${Math.max(tickDropPct, twoTickDropPct).toFixed(1)}% dump` });
  }
  const dipPct = highSq > 0n ? Number(((highSq - sq) * 10000n) / highSq) / 100 : 0;
  if (coinSnap.historyReady && dipPct >= VALUE_THRESHOLD && stable) {
    signals.push({ type: 'VALUE', detail: `${dipPct.toFixed(1)}% below 1h high, stable` });
  }
  const aboveLowPct = lowSq > 0n && sq > lowSq ? Number(((sq - lowSq) * 10000n) / lowSq) / 100 : 0;
  const lowAge = now - (coinSnap.low24hTs ?? now);
  if (coinSnap.historyReady && aboveLowPct >= BOTTOM_MIN_BOUNCE_PCT && aboveLowPct <= NEAR_LOW_PCT && lowAge >= BOTTOM_MIN_LOW_AGE_MS) {
    signals.push({ type: 'BOTTOM', detail: `${aboveLowPct.toFixed(1)}% above a 24h low that held ${(lowAge / 60e3).toFixed(0)}m` });
  }
  const ageHours = (now - (coinSnap.firstSeenTs || now)) / 3600e3;
  if (ageHours < LAUNCH_AGE_HOURS && coinSnap.launchHighSq) {
    const lh = BigInt(coinSnap.launchHighSq);
    const pullbackPct = lh > 0n ? Number(((lh - sq) * 10000n) / lh) / 100 : 0;
    const demand = (tape.externalBuyers || 0) >= MIN_EXTERNAL_BUYERS;
    if (pullbackPct >= LAUNCH_PULLBACK_MIN && pullbackPct <= LAUNCH_PULLBACK_MAX && stable && demand) {
      signals.push({ type: 'LAUNCH-PULLBACK', sizePct: PROBE_SIZE_PCT,
        detail: `${pullbackPct.toFixed(1)}% below launch high, ${tape.externalBuyers} external buyers — PROBE ${PROBE_SIZE_PCT}%` });
    }
  }
  return { signals, metrics: { tickDropPct, twoTickDropPct, dipPct, aboveLowPct, ageHours } };
}

async function main() {
  // Network audit: the dry-run must make ZERO network calls.
  let networkCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (...a) => { networkCalls++; console.log(`  [AUDIT] network call: ${String(a[0]).slice(0, 80)}`); return origFetch(...a); };
  const args = process.argv.slice(2);
  const snapPath = args.includes('--snapshot') ? args[args.indexOf('--snapshot') + 1] : './market-snapshot.json';
  const wlPath = args.includes('--watchlist') ? args[args.indexOf('--watchlist') + 1] : './watchlist.json';
  if (!existsSync(snapPath)) { console.error(`snapshot not found: ${snapPath} — run market-watcher.mjs first`); process.exit(2); }
  const snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
  const watchlist = JSON.parse(readFileSync(wlPath, 'utf8'));
  const { assignments, scored } = computeAssignment(snapshot, watchlist);
  for (const s of scored) if (s.score < 0) console.log(`skip ${s.name}: ${s.reason}`);
  // One baby per coin per tick may act (anti-herd): the first assigned baby with a signal.
  const actedOn = new Set();
  const decisions = [];
  for (let i = 0; i < 16; i++) {
    for (const addr of assignments[i]) {
      const cs = snapshot.coins[addr];
      if (!cs) continue;
      const { signals, reason } = evaluateSignals(cs);
      if (!signals.length) { if (reason) console.log(`w${i} ${cs.name}: ${reason}`); continue; }
      if (actedOn.has(addr)) { console.log(`w${i} ${cs.name}: signal, but another baby already acts on this coin this tick`); continue; }
      actedOn.add(addr);
      decisions.push({ baby: i, coin: cs.name, signals: signals.map((s) => s.type) });
      console.log(`w${i} ${cs.name}: BUY SIGNAL — ${signals.map((s) => `${s.type} (${s.detail})`).join(', ')}`);
    }
  }
  console.log(`\n=== dry-run: ${decisions.length} decisions, ${networkCalls} network calls (must be 0) ===`);
  if (networkCalls > 0) { console.log('FAIL: babies made network calls for market data'); process.exit(1); }
  console.log('PASS');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
