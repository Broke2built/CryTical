// assignment.mjs — baby↔coin assignment for the fleet-wide trader.
//
// Dual mandate (Anthony 2026-10-08): babies are a personal trading army.
// Every assignment weighs BOTH profit edge AND visibility for Anthony's coins.
// New launches get priority — that's where outside buyers look first.
//
// Assignment strategy: specialist/generalist split
//   - Babies 0-7: SCOUTS — new launches + high-volatility coins (visibility focus)
//   - Babies 8-15: HARVESTERS — active past coins with profit edge (profit focus)
// Each baby watches up to 3 coins. Dead coins (60+ quiet ticks) get 0 babies.
//
// Recomputed hourly by the watcher; babies read their assignment from KV.

import { readFileSync, existsSync } from 'node:fs';

const MAX_COINS_PER_BABY = 3;
const SCOUT_COUNT = 8; // babies 0-7 are scouts

/**
 * Compute assignment from snapshot + watchlist.
 * @param {object} snapshot - market snapshot {coins: {addr: {...}}}
 * @param {object} watchlist - {coins: [{address, name, priority}]}
 * @returns {object} { assignments: {babyIdx: [addr...]}, coinBabies: {addr: [babyIdx...]} }
 */
export function computeAssignment(snapshot, watchlist) {
  const coins = watchlist.coins || [];
  const snapCoins = snapshot?.coins || {};

  // Score each coin for assignment (dual mandate)
  const scored = coins.map(c => {
    const s = snapCoins[c.address];
    if (!s || !s.valid) return { ...c, score: -1, reason: 'no data' };
    if (s.dead) return { ...c, score: -1, reason: 'dead' };

    let score = 0;
    // Visibility: new launches get priority
    const ageHours = (Date.now() - (s.firstSeenTs || Date.now())) / 3600e3;
    if (ageHours < 24) score += 100;           // brand new: max visibility
    else if (ageHours < 168) score += 50;       // first week: high visibility
    if (c.priority === 'high') score += 30;
    else if (c.priority === 'medium') score += 15;

    // Profit edge: volatility + tape activity
    const tape = s.tape || {};
    const totalVol = (tape.buyVol || 0) + (tape.sellVol || 0);
    score += Math.min(40, totalVol / 10);       // up to 40 for $400+ volume
    score += Math.min(20, (tape.buyCount + tape.sellCount) * 2); // up to 20 for 10+ swaps
    if (Math.abs(s.moveBps) >= 50) score += 10; // moving now

    // Penalty for quiet
    score -= (s.quietTicks || 0) * 0.5;

    return { ...c, score, ageHours, reason: 'active' };
  }).filter(c => c.score >= 0).sort((a, b) => b.score - a.score);

  const assignments = {};
  const coinBabies = {};
  for (let i = 0; i < 16; i++) assignments[i] = [];
  for (const c of scored) coinBabies[c.address] = [];

  // Scouts (0-7): top coins by score (new launches first)
  // Harvesters (8-15): top coins by profit signals (volume/volatility)
  const profitRanked = [...scored].sort((a, b) => {
    const sa = snapCoins[a.address]?.tape;
    const sb = snapCoins[b.address]?.tape;
    const va = ((sa?.buyVol || 0) + (sa?.sellVol || 0));
    const vb = ((sb?.buyVol || 0) + (sb?.sellVol || 0));
    return vb - va;
  });

  // Assign scouts to highest-visibility coins
  for (let i = 0; i < SCOUT_COUNT; i++) {
    const picks = scored.slice(0, MAX_COINS_PER_BABY);
    for (const p of picks) {
      const addr = p.address;
      if (!assignments[i].includes(addr)) {
        assignments[i].push(addr);
        coinBabies[addr].push(i);
      }
    }
  }
  // Assign harvesters to highest-profit coins
  for (let i = SCOUT_COUNT; i < 16; i++) {
    const picks = profitRanked.slice(0, MAX_COINS_PER_BABY);
    for (const p of picks) {
      const addr = p.address;
      if (!assignments[i].includes(addr)) {
        assignments[i].push(addr);
        coinBabies[addr].push(i);
      }
    }
  }

  return { assignments, coinBabies, scored: scored.map(c => ({ address: c.address, name: c.name, score: Math.round(c.score), reason: c.reason })) };
}

// CLI: compute and print assignment from snapshot + watchlist
if (import.meta.url === `file://${process.argv[1]}`) {
  const snapPath = process.argv[2] || './market-snapshot.json';
  const wlPath = process.argv[3] || './watchlist.json';
  if (!existsSync(snapPath)) { console.error(`snapshot not found: ${snapPath}`); process.exit(2); }
  const snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
  const watchlist = JSON.parse(readFileSync(wlPath, 'utf8'));
  const { assignments, coinBabies, scored } = computeAssignment(snapshot, watchlist);
  console.log('=== coin scores ===');
  for (const s of scored) console.log(`  ${s.name}: score=${s.score} (${s.reason})`);
  console.log('\n=== baby assignments ===');
  for (let i = 0; i < 16; i++) {
    const role = i < SCOUT_COUNT ? 'SCOUT' : 'HARVEST';
    console.log(`  w${i} [${role}]: ${assignments[i].map(a => {
      const c = watchlist.coins.find(x => x.address === a);
      return c?.name || a.slice(0, 8);
    }).join(', ') || '(none)'}`);
  }
  console.log('\n=== coin coverage ===');
  for (const [addr, babies] of Object.entries(coinBabies)) {
    const c = watchlist.coins.find(x => x.address === addr);
    console.log(`  ${c?.name || addr.slice(0, 8)}: ${babies.length} babies [${babies.join(',')}]`);
  }
}
