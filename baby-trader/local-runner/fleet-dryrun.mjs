// fleet-dryrun.mjs — dry-run the fleet-wide baby trader WITHOUT touching live wallets.
//
// Proves the architecture: 16 babies read the shared market snapshot and make
// trading decisions with ZERO per-baby network calls for market data.
// All market data comes from market-snapshot.json (written by market-watcher.mjs).
//
// Simulates the buy-signal logic for each baby x assigned coin:
//   1. CRASH BUY: sudden dump >= threshold (from snapshot moveBps + buckets)
//   2. VALUE BUY: price >= threshold below 1h high AND stable
//   3. BOTTOM BUY: price within 10% of 24h low
//   4. LAUNCH-PULLBACK (new): fresh coin, 20-30% below launch high → enter small
//
// Also computes tape features (buy/sell flow, dip recovery) that feed the regime state.
//
// Usage: node fleet-dryrun.mjs [--snapshot path] [--watchlist path]
// Output: per-baby decisions + network call audit (must be 0 for market data)

import { readFileSync, existsSync } from 'node:fs';
import { computeAssignment } from './assignment.mjs';

// Buy signal thresholds (from worker.js grids — using mid values for dry-run)
const DUMP_THRESHOLD = 40;    // crash buy: 40% dump
const VALUE_THRESHOLD = 80;   // value buy: 80% below 1h high
const NEAR_LOW_PCT = 10;      // bottom buy: within 10% of 24h low
const LAUNCH_PULLBACK_MIN = 20; // fresh-coin: 20% below launch high
const LAUNCH_PULLBACK_MAX = 30; // fresh-coin: 30% below launch high (don't catch falling knife)
const LAUNCH_AGE_HOURS = 24;    // "fresh" = launched within 24h

// Network call audit: track every fetch/RPC the dry-run makes (must be 0)
let networkCalls = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  networkCalls++;
  console.log(`  [AUDIT] network call #${networkCalls}: ${String(args[0]).slice(0, 80)}`);
  return origFetch(...args);
};

function evaluateSignals(coinAddr, coinSnap, babyIdx) {
  const signals = [];
  const sq = BigInt(coinSnap.priceSq);
  const highSq = BigInt(coinSnap.high1hSq);
  const lowSq = BigInt(coinSnap.low24hSq);

  if (sq <= 0n) return { signals, reason: 'no price' };

  // 1. CRASH BUY: use moveBps (1-tick) as proxy for sudden dump
  const tickDropPct = coinSnap.moveBps < 0 ? -coinSnap.moveBps / 100 : 0;
  // 2-tick: check buckets for the drop over last 2 entries
  let twoTickDropPct = 0;
  const buckets = coinSnap.buckets || [];
  if (buckets.length >= 3) {
    const b0 = BigInt(buckets[buckets.length - 3].sq);
    if (b0 > sq) twoTickDropPct = Number((b0 - sq) * 10000n / b0) / 100;
  }
  if (tickDropPct >= DUMP_THRESHOLD || twoTickDropPct >= DUMP_THRESHOLD) {
    signals.push({ type: 'CRASH', detail: `${Math.max(tickDropPct, twoTickDropPct).toFixed(1)}% dump` });
  }

  // 2. VALUE BUY: dip from 1h high — GATED on historyReady (cold-start guard)
  const dipPct = highSq > 0n ? Number((highSq - sq) * 10000n / highSq) / 100 : 0;
  const stable = tickDropPct < 10; // not mid-crash
  if (coinSnap.historyReady && dipPct >= VALUE_THRESHOLD && stable) {
    signals.push({ type: 'VALUE', detail: `${dipPct.toFixed(1)}% below 1h high, stable` });
  }

  // 3. BOTTOM BUY: near 24h low — GATED on historyReady (cold-start guard).
  // Without this, the first tick after adding a coin fires BOTTOM everywhere
  // because low24h initializes to the current price.
  const aboveLowPct = coinSnap.aboveLowPct || 0;
  if (coinSnap.historyReady && aboveLowPct <= NEAR_LOW_PCT) {
    signals.push({ type: 'BOTTOM', detail: `${aboveLowPct.toFixed(1)}% above 24h low` });
  }

  // 4. LAUNCH-PULLBACK (fresh-coin bootstrap): 20-30% below launch high, coin < 24h old
  const ageHours = (Date.now() - (coinSnap.firstSeenTs || Date.now())) / 3600e3;
  if (ageHours < LAUNCH_AGE_HOURS && coinSnap.launchHighSq) {
    const launchHigh = BigInt(coinSnap.launchHighSq);
    const pullbackPct = launchHigh > 0n ? Number((launchHigh - sq) * 10000n / launchHigh) / 100 : 0;
    if (pullbackPct >= LAUNCH_PULLBACK_MIN && pullbackPct <= LAUNCH_PULLBACK_MAX && stable) {
      signals.push({ type: 'LAUNCH-PULLBACK', detail: `${pullbackPct.toFixed(1)}% below launch high (age ${ageHours.toFixed(1)}h) — ENTER SMALL` });
    }
  }

  return { signals, metrics: { tickDropPct, twoTickDropPct, dipPct, aboveLowPct, ageHours } };
}

function computeTapeFeatures(coinSnap) {
  // Trade-history features that feed the regime state (Anthony: "past trades are important")
  const tape = coinSnap.tape || {};
  const buyVol = tape.buyVol || 0;
  const sellVol = tape.sellVol || 0;
  const totalVol = buyVol + sellVol;

  return {
    // Buy/sell flow imbalance: +1 = all buying, -1 = all selling, 0 = balanced/empty
    flowImbalance: totalVol > 0 ? (buyVol - sellVol) / totalVol : 0,
    // Activity level: normalized 0-1 (10+ swaps = 1.0)
    activityLevel: Math.min(1, ((tape.buyCount || 0) + (tape.sellCount || 0)) / 10),
    // Whale presence: 1 if whales active
    whaleActive: (tape.whaleNet || 0) !== 0 ? 1 : 0,
    // Buyer diversity: unique buyers (more = healthier)
    buyerDiversity: Math.min(1, (tape.uniqueBuyerCount || 0) / 10),
    // Recency: seconds since last swap (capped at 1h)
    secsSinceSwap: tape.lastSwapTs ? Math.min(3600, (Date.now() - tape.lastSwapTs) / 1000) : 3600,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const snapPath = args.includes('--snapshot') ? args[args.indexOf('--snapshot') + 1] : './market-snapshot.json';
  const wlPath = args.includes('--watchlist') ? args[args.indexOf('--watchlist') + 1] : './watchlist.json';

  if (!existsSync(snapPath)) { console.error(`snapshot not found: ${snapPath} — run market-watcher.mjs first`); process.exit(2); }
  const snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
  const watchlist = JSON.parse(readFileSync(wlPath, 'utf8'));

  console.log(`snapshot ts: ${new Date(snapshot.ts).toISOString()}`);
  console.log(`watcher cost: ${snapshot.meta?.httpRequests} HTTP requests, ${snapshot.meta?.elapsedMs}ms\n`);

  const { assignments } = computeAssignment(snapshot, watchlist);

  let totalSignals = 0;
  let decisions = [];

  for (let i = 0; i < 16; i++) {
    const role = i < 8 ? 'SCOUT' : 'HARVEST';
    const coins = assignments[i];
    if (!coins.length) {
      console.log(`w${i} [${role}]: no coins assigned (all dead or no data)`);
      continue;
    }
    for (const addr of coins) {
      const cs = snapshot.coins[addr];
      if (!cs) continue;
      const { signals, metrics } = evaluateSignals(addr, cs, i);
      const tapeFeats = computeTapeFeatures(cs);

      if (signals.length > 0) {
        totalSignals++;
        decisions.push({ baby: i, coin: cs.name, signals: signals.map(s => s.type) });
        console.log(`w${i} [${role}] ${cs.name}: BUY SIGNAL — ${signals.map(s => `${s.type} (${s.detail})`).join(', ')}`);
      } else {
        // Only log quiet when metrics are interesting
        if (metrics && (metrics.dipPct > 5 || metrics.aboveLowPct < 50)) {
          console.log(`w${i} [${role}] ${cs.name}: no signal (dip ${metrics.dipPct.toFixed(1)}%, ${metrics.aboveLowPct.toFixed(1)}% above low, flow ${tapeFeats.flowImbalance.toFixed(2)})`);
        }
      }
    }
  }

  console.log(`\n=== dry-run summary ===`);
  console.log(`total buy signals: ${totalSignals}`);
  console.log(`market-data network calls by babies: ${networkCalls} (must be 0)`);
  console.log(`decisions: ${JSON.stringify(decisions)}`);

  if (networkCalls > 0) {
    console.log('FAIL: babies made network calls for market data!');
    process.exit(1);
  }
  console.log('PASS: zero per-baby market-data network calls');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
