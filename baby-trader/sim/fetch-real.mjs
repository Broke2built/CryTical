// fetch-real.mjs — pull REAL swap history from Base (Uniswap V4 PoolManager) and save
// a compact per-pool dataset the synthetic market generator learns from.
//
// ============================== NOTES FOR WREN ==============================
// Why swaps and not prices: the tournament needs ORDER FLOW (who trades, how big, how
// often, in which direction), because the babies' own trades must move the simulated
// pool. A replayed price path can't react to the babies; a flow model can.
//
// Units: we record each swap's PRICE IMPACT (log change of the pool price) instead of
// token amounts. Impact is unit-free, so a flow learned on any thin pool can be
// replayed into the sim pool at any size: a CPMM buy that moves price by factor R costs
// x = weth * (sqrt(R) - 1). Direction is relative to currency0 — symmetric for training.
//
// Which pools: every V4 pool on Base that traded in the window, kept if it had enough
// swaps and THIN liquidity (Zora coin pools are V4 and thin; deep blue-chip pools are
// dropped). Pass --pool <poolId> to force-include a specific pool (e.g. BRAWL).
// ===========================================================================
//
// Usage: node sim/fetch-real.mjs [--hours 4] [--out file] [--pool <poolId>]
//   Run it every few hours (cron) — each run adds a file to sim/data/ and synth.mjs
//   learns from all of them. More real hours = richer, less overfit synthetic markets.
//   RPC_URL (default https://base-rpc.publicnode.com — serves ~1000-block getLogs)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const RPC = process.env.RPC_URL || 'https://base-rpc.publicnode.com';
const HOURS = +arg('--hours', 4); // free publicnode keeps ~4-8h; a keyed archive RPC can go back days
const OUT_ARG = arg('--out', null); // default: sim/data/real-flow-<toBlock>.json (runs ACCUMULATE)
const CHUNK = 1000;                  // blocks per getLogs (publicnode caps results at 20k)
const BLOCK_S = 2;
const MIN_SWAPS = 40;                // per pool, to estimate anything at all
const MAX_LIQ = 1e24;                // "thin" pool cutoff on the V4 liquidity value
const FORCE = new Set(args.filter((a, i) => args[i - 1] === '--pool').map((x) => x.toLowerCase()));
const POOLMANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

async function rpc(method, params, tries = 5) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      if (k >= tries) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** k));
    }
  }
}

// Busy stretches exceed the provider's 20k-results cap: split the range and retry.
async function getRange(lo, hi) {
  try {
    return await rpc('eth_getLogs', [{ address: POOLMANAGER, topics: [SWAP], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }], 2);
  } catch (e) {
    if (hi <= lo) throw e;
    const mid = Math.floor((lo + hi) / 2);
    return [...(await getRange(lo, mid)), ...(await getRange(mid + 1, hi))];
  }
}

const head = parseInt(await rpc('eth_blockNumber', []), 16);
const from = head - Math.round((HOURS * 3600) / BLOCK_S);
const pools = new Map(); // poolId -> [[block, logIndex, sqrtP(float), liquidity(float)]]
let n = 0;
for (let b = from; b <= head; b += CHUNK) {
  const to = Math.min(head, b + CHUNK - 1);
  const logs = await getRange(b, to);
  for (const l of logs) {
    const d = l.data.slice(2);
    const sqrtP = Number(BigInt('0x' + d.slice(128, 192)));
    const liq = Number(BigInt('0x' + d.slice(192, 256)));
    const id = l.topics[1].toLowerCase();
    if (!pools.has(id)) pools.set(id, []);
    pools.get(id).push([parseInt(l.blockNumber, 16), parseInt(l.logIndex, 16), sqrtP, liq]);
    n++;
  }
  process.stderr.write(`\rblocks ${b - from + CHUNK}/${head - from}  swaps ${n}  pools ${pools.size}   `);
}
process.stderr.write('\n');

// Per pool: sequence of swaps -> [blockOffset, logImpact] where logImpact = ln(P_after/P_before).
const out = { source: 'Base Uniswap V4 PoolManager Swap events', fetchedAt: new Date().toISOString(),
  fromBlock: from, toBlock: head, blockSeconds: BLOCK_S, pools: {} };
for (const [id, sw] of pools) {
  sw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const medLiq = sw.map((s) => s[3]).sort((a, b) => a - b)[Math.floor(sw.length / 2)];
  if (!FORCE.has(id) && (sw.length < MIN_SWAPS || medLiq > MAX_LIQ)) continue;
  const ev = [];
  for (let k = 1; k < sw.length; k++) {
    if (!(sw[k - 1][2] > 0 && sw[k][2] > 0)) continue;
    const imp = 2 * Math.log(sw[k][2] / sw[k - 1][2]); // price = sqrtP^2
    if (!Number.isFinite(imp) || Math.abs(imp) > 3) continue; // drop re-inits / absurd jumps
    ev.push([sw[k][0] - from, +imp.toFixed(6)]);
  }
  if (ev.length >= MIN_SWAPS - 1 || FORCE.has(id)) out.pools[id] = { swaps: ev.length, medianLiquidity: medLiq, events: ev };
}
const OUT = OUT_ARG || new URL(`./data/real-flow-${head}.json`, import.meta.url).pathname;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`kept ${Object.keys(out.pools).length} thin active pools of ${pools.size} -> ${OUT}`);
