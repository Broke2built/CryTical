// assignment.mjs — baby <-> coin assignment for the fleet-wide trader.
//
// ============================== NOTES FOR WREN ==============================
// What changed in review (2026-10-08) and why:
//  * HERDING. The old code gave all 8 scouts the SAME top-3 coins and all 8 harvesters
//    the SAME top-3-by-volume coins: 8 babies on one thin pool, all reading the same
//    snapshot, all firing the same signal on the same tick. They front-run each other
//    (baby #2 buys at baby #1's impact) and the chain sees a synchronized 8-wallet buy —
//    the exact choreography you already banned for stop-losses. Now coins are dealt
//    round-robin with a hard cap of MAX_BABIES_PER_COIN.
//  * UNITS. Coins were ranked on raw coin-unit volume ("$400+" in the comment, but the
//    number was BRAWL units — millions). Ranking now uses WETH volume, which is
//    comparable across coins.
//  * WHAT A COIN NEEDS TO GET BABIES: real counterparties. Score = EXTERNAL flow
//    (traders that are not our wallets) + volatility. A coin with no external traders
//    in the last hour gets ZERO babies: with nobody else there, the only P&L available
//    is taking it from each other, minus gas, on a public chart. Fleet-vs-fleet
//    practice happens in sim/tournament.mjs (or on a fork), never on a live pool.
//  * The old "visibility" bonus (+100 for new launches so outside buyers notice) is
//    removed. Trading to be noticed is promotion through volume, not trading.
// ===========================================================================

import { readFileSync, existsSync } from 'node:fs';

export const MAX_COINS_PER_BABY = 3;
export const MAX_BABIES_PER_COIN = 4;
export const MIN_EXTERNAL_SWAPS_1H = 3; // below this, a coin is "dead" for trading purposes

export function scoreCoin(c, s) {
  if (!s || !s.valid) return { score: -1, reason: 'no data' };
  if (!s.historyReady) return { score: -1, reason: 'warming up (<10 ticks of history)' };
  const ext1h = s.externalSwaps1h ?? 0;
  if (ext1h < MIN_EXTERNAL_SWAPS_1H) return { score: -1, reason: `no real market (${ext1h} external swaps/1h)` };
  const t = s.tape || {};
  const extWeth = (t.externalBuyWeth || 0) + (t.externalSellWeth || 0);
  let score = 0;
  score += Math.min(40, extWeth * 4000);            // ~0.01 WETH external flow / 10 min -> 40
  score += Math.min(30, (t.externalTraders || 0) * 5); // distinct real traders
  score += Math.min(20, ext1h);                     // sustained external activity
  if (Math.abs(s.moveBps || 0) >= 50) score += 10;  // moving now
  return { score, reason: 'active' };
}

export function computeAssignment(snapshot, watchlist, nBabies = 16) {
  const snapCoins = snapshot?.coins || {};
  const banned = new Set((watchlist.banned || []).map((b) => b.address.toLowerCase()));
  const scored = (watchlist.coins || [])
    .filter((c) => !banned.has(c.address.toLowerCase()))
    .map((c) => ({ ...c, ...scoreCoin(c, snapCoins[c.address]) }));
  const tradable = scored.filter((c) => c.score >= 0).sort((a, b) => b.score - a.score);

  const assignments = {}, coinBabies = {};
  for (let i = 0; i < nBabies; i++) assignments[i] = [];
  for (const c of tradable) coinBabies[c.address] = [];
  // Deal coins like cards: baby i starts at a different rank offset, so babies hold
  // different coin sets, and no coin exceeds MAX_BABIES_PER_COIN.
  if (tradable.length) {
    for (let round = 0; round < MAX_COINS_PER_BABY; round++) {
      for (let i = 0; i < nBabies; i++) {
        for (let k = 0; k < tradable.length; k++) {
          const c = tradable[(i + round + k) % tradable.length];
          if (coinBabies[c.address].length >= MAX_BABIES_PER_COIN) continue;
          if (assignments[i].includes(c.address)) continue;
          assignments[i].push(c.address);
          coinBabies[c.address].push(i);
          break;
        }
      }
    }
  }
  return { assignments, coinBabies,
    scored: scored.map((c) => ({ address: c.address, name: c.name, score: Math.round(c.score), reason: c.reason })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const snapPath = process.argv[2] || './market-snapshot.json';
  const wlPath = process.argv[3] || './watchlist.json';
  if (!existsSync(snapPath)) { console.error(`snapshot not found: ${snapPath}`); process.exit(2); }
  const snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
  const watchlist = JSON.parse(readFileSync(wlPath, 'utf8'));
  const { assignments, coinBabies, scored } = computeAssignment(snapshot, watchlist);
  const nameOf = (a) => watchlist.coins.find((x) => x.address === a)?.name || a.slice(0, 8);
  console.log('=== coin scores ===');
  for (const s of scored) console.log(`  ${s.name}: score=${s.score} (${s.reason})`);
  console.log('\n=== baby assignments ===');
  for (const [i, list] of Object.entries(assignments)) console.log(`  w${i}: ${list.map(nameOf).join(', ') || '(none — no coin has a real market)'}`);
  console.log('\n=== coin coverage ===');
  for (const [addr, babies] of Object.entries(coinBabies)) console.log(`  ${nameOf(addr)}: ${babies.length} babies [${babies.join(',')}]`);
}
