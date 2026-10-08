// market-watcher.mjs — CENTRALIZED market data fetcher for the baby fleet.
//
// One process pulls price + swap tape for every watched coin once per tick and
// writes a shared snapshot; the 16 babies READ it (zero per-baby market-data calls).
//
// ============================== NOTES FOR WREN ==============================
// Review 2026-10-08 fixed five real bugs in the first version. Know them, because
// each one silently produced plausible-looking but WRONG numbers:
//
// 1. PRICE ORIENTATION. A V4 pool's sqrtPriceX96 is always currency1-per-currency0.
//    The coin is currency0 only when its address sorts below WETH (0x4200...). For any
//    coin ABOVE 0x4200 the old code stored WETH-per-coin INVERTED: a dump looked like a
//    pump, the "1h high" was really the low, CRASH fired on rallies. Every price here
//    is now normalized to "coin price in WETH * 2^192" (same convention as worker.js
//    `sq`, which is LINEAR in price — not price^2, whatever older comments say).
// 2. TAPE UNITS. Volume used amount0 for every pool. For a coin that is currency1,
//    amount0 is WETH, so "coin volume" was really WETH volume and whale detection
//    (>1M coin units) could never fire. Now coin units and WETH units are separate,
//    and assignment ranks on WETH volume (comparable across coins).
// 3. getLogs WAS FETCHED N TIMES. The batch sent the identical "all PoolManager logs
//    for 300 blocks" call once per coin. On Base that is thousands of logs, N times.
//    Now: one call, filtered locally by poolId.
// 4. "24h LOW" WAS A 1h LOW. Snapshot history was trimmed to 60 buckets, and the next
//    tick rebuilt history from the snapshot. Now 1440 buckets (24h of 1-min ticks).
// 5. "UNIQUE BUYERS" COUNTED ROUTERS. Swap.sender is whoever called PoolManager —
//    the router contract, not the human. Now we look up tx.from for the swaps in our
//    pools and split EXTERNAL traders from FLEET wallets.
//
// WHY EXTERNAL vs FLEET MATTERS (read this twice): the fleet's own buys are not
// demand. A coin where only our 16 wallets trade has no one to sell to but us, and
// every "profit" is another baby's loss minus gas. `tape.external*` is the number
// that says whether real counterparties exist. Entry rules for fresh/dead coins key
// off it (see fleet-dryrun.mjs). Do not count fleet flow as market interest, and never
// trade a public pool *to create* activity — that is wash trading even if the wallets
// "compete". Fleet-vs-fleet tournaments belong on a fork or in the sim.
// ===========================================================================
//
// Usage:
//   node market-watcher.mjs [--watchlist path] [--out path] [--dry-run]
//   Env: RPC_URLS (comma list), KV_FILE (optional KV mirror), FLEET_ADDRESSES (optional
//   comma list; defaults to worker.js BURNERS).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { keccak256, encodeAbiParameters, encodeFunctionData } from 'viem';

export const WETH = '0x4200000000000000000000000000000000000006';
const STATEVIEW = '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71';
const POOLMANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
// WARNING: this assumes EVERY watched coin uses the same Zora hook / fee / tickSpacing.
// Zora has shipped several hook versions. A coin on a different hook derives the wrong
// poolId, getSlot0 returns zeros, and the coin is marked valid=false. Prefer storing
// the real PoolKey per coin in watchlist.json ({ poolKey: {fee, tickSpacing, hooks} }).
const ZORA_HOOK = '0x0469a4Bd3724DC86C9542F4694c976DA13C450c0';
export const SWAP_TOPIC0 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const SWAP_LOOKBACK_BLOCKS = 300; // ~10 min on Base (2s blocks)
const BLOCK_MS = 2000;
const WHALE_UNITS = 1000000;      // single swap >1M coin units = whale
const DEAD_MOVE_BPS = 50;         // <0.50% move = quiet tick
const DEAD_TICKS = 60;            // 60 quiet ticks = dead coin
const HISTORY_BUCKETS = 1440;     // 24h of 1-min ticks (was 60 -> "24h low" was a 1h low)
const MAX_TX_LOOKUPS = 100;       // cap on tx.from lookups per tick
const Q192 = 2n ** 192n;

export const coinIsToken0 = (coin) => coin.toLowerCase() < WETH.toLowerCase();

export function poolIdFor(coin, poolKey = {}) {
  const t0 = coinIsToken0(coin);
  return keccak256(encodeAbiParameters(
    [{ type: 'tuple', components: [
      { type: 'address', name: 'currency0' }, { type: 'address', name: 'currency1' },
      { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' },
    ] }],
    [[t0 ? coin : WETH, t0 ? WETH : coin, poolKey.fee ?? 8388608, poolKey.tickSpacing ?? 200, poolKey.hooks ?? ZORA_HOOK]],
  ));
}

// sqrtPriceX96 -> coin price in WETH * 2^192 (orientation-normalized, linear in price).
export function coinPriceSq(sqrtPriceX96, coin) {
  if (sqrtPriceX96 <= 0n) return 0n;
  const raw = sqrtPriceX96 * sqrtPriceX96; // currency1 per currency0, * 2^192
  return coinIsToken0(coin) ? raw : (Q192 * Q192) / raw;
}

const toSigned128 = (w) => (w >= (1n << 255n) ? w - (1n << 256n) : w);
// (review) UNISWAP V4 SIGN CONVENTION — verified on real Base txs (test/fixtures/v4-swaps.json):
// Swap.amount0/amount1 are deltas FOR THE SWAPPER (not the pool, unlike V3).
//   amount > 0 -> the trader RECEIVED that currency (bought it)
//   amount < 0 -> the trader PAID that currency in (sold it)
// (My first version of this said "deltas for the pool" — wrong; buy/sell were swapped.)
export function decodeSwap(log, coin) {
  const d = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  const a0 = toSigned128(BigInt('0x' + d.slice(0, 64)));
  const a1 = toSigned128(BigInt('0x' + d.slice(64, 128)));
  const t0 = coinIsToken0(coin);
  const coinDelta = t0 ? a0 : a1;
  const wethDelta = t0 ? a1 : a0;
  const abs = (x) => (x < 0n ? -x : x);
  return {
    traderBought: coinDelta > 0n, // trader received the coin -> bought
    coinUnits: Number(abs(coinDelta)) / 1e18,
    weth: Number(abs(wethDelta)) / 1e18,
  };
}

let rpcId = 1;
async function rpcBatch(url, calls, timeoutMs = 25000) {
  if (!calls.length) return [];
  const batch = calls.map((c) => ({ jsonrpc: '2.0', id: rpcId++, method: c.method, params: c.params }));
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const out = await res.json();
  const byId = {};
  for (const r of (Array.isArray(out) ? out : [out])) byId[r.id] = r;
  return batch.map((b) => {
    const r = byId[b.id];
    if (!r) throw new Error(`missing response for id ${b.id}`);
    if (r.error) throw new Error(`RPC error: ${JSON.stringify(r.error).slice(0, 120)}`);
    return r.result;
  });
}
async function firstWorking(urls, calls, label, log) {
  let lastErr;
  for (const url of urls) {
    try { return { result: await rpcBatch(url, calls), url }; } catch (e) { lastErr = e; log(`${label} failed on ${url}: ${String(e.message).slice(0, 80)}`); }
  }
  throw lastErr || new Error(`${label}: no RPCs`);
}

const STATEVIEW_ABI = [{ name: 'getSlot0', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'poolId', type: 'bytes32' }],
  outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' }] }];

// Pure: build one coin's snapshot entry from this tick's reads + the previous entry.
// swaps: [{traderBought, coinUnits, weth, from, block}] already filtered to this pool.
export function buildCoinEntry({ coin, name, pid, sq, prev, swaps, fleet, now, curBlock, tapeOk = true }) {
  const valid = sq > 0n;
  const buckets = [...(prev?.buckets || []), ...(valid ? [{ ts: now, sq: sq.toString() }] : [])].slice(-HISTORY_BUCKETS);
  const prevSq = prev?.priceSq ? BigInt(prev.priceSq) : 0n;
  const moveBps = prevSq > 0n && valid ? Number(((sq - prevSq) * 10000n) / prevSq) : 0;
  let highSq = sq, lowSq = sq, lowTs = now;
  for (const b of buckets) {
    const bsq = BigInt(b.sq);
    if (bsq <= 0n) continue;
    if (b.ts >= now - 3600e3 && bsq > highSq) highSq = bsq;
    if (b.ts >= now - 86400e3 && bsq < lowSq) { lowSq = bsq; lowTs = b.ts; }
  }
  const historyTicks = (prev?.historyTicks || 0) + (valid ? 1 : 0);
  const quietTicks = Math.abs(moveBps) >= DEAD_MOVE_BPS ? 0 : (prev?.quietTicks || 0) + 1;

  const tape = { buyVol: 0, sellVol: 0, buyWeth: 0, sellWeth: 0, buyCount: 0, sellCount: 0, whaleNet: 0,
    externalBuyWeth: 0, externalSellWeth: 0, externalSwaps: 0, fleetSwaps: 0, unknownSwaps: 0, lastSwapTs: 0 };
  const extBuyers = new Set(), extTraders = new Set();
  for (const s of swaps) {
    if (s.traderBought) { tape.buyVol += s.coinUnits; tape.buyWeth += s.weth; tape.buyCount++; }
    else { tape.sellVol += s.coinUnits; tape.sellWeth += s.weth; tape.sellCount++; }
    if (s.coinUnits > WHALE_UNITS) tape.whaleNet += s.traderBought ? s.coinUnits : -s.coinUnits;
    if (!s.from) tape.unknownSwaps++;
    else if (fleet.has(s.from.toLowerCase())) tape.fleetSwaps++;
    else {
      tape.externalSwaps++;
      extTraders.add(s.from.toLowerCase());
      if (s.traderBought) { tape.externalBuyWeth += s.weth; extBuyers.add(s.from.toLowerCase()); }
      else tape.externalSellWeth += s.weth;
    }
    const ts = now - Number(curBlock - (s.block ?? curBlock)) * BLOCK_MS;
    if (ts > tape.lastSwapTs) tape.lastSwapTs = ts;
  }
  const r = (x, d = 1e6) => Math.round(x * d) / d;
  for (const k of ['buyVol', 'sellVol', 'whaleNet']) tape[k] = r(tape[k], 100);
  for (const k of ['buyWeth', 'sellWeth', 'externalBuyWeth', 'externalSellWeth']) tape[k] = r(tape[k], 1e9);
  tape.externalBuyers = extBuyers.size;
  tape.externalTraders = extTraders.size;
  tape.ok = tapeOk; // false = logs failed this tick; zeros mean UNKNOWN, not "no trades"

  const dipBps = highSq > 0n ? Number(((highSq - sq) * 10000n) / highSq) : 0;
  const aboveLowPct = lowSq > 0n && sq > lowSq ? Number(((sq - lowSq) * 10000n) / lowSq) / 100 : 0;
  const launchHighSq = prev?.launchHighSq && BigInt(prev.launchHighSq) >= sq ? prev.launchHighSq : (valid ? sq.toString() : prev?.launchHighSq ?? null);
  // Rolling count of external activity over the last ~hour of ticks (dead-coin detection
  // that ignores our own churn).
  const extHist = [...(prev?.externalSwapsHist || []), tape.externalSwaps].slice(-60);
  return {
    name: name || coin.slice(0, 10), poolId: pid, valid,
    priceSq: sq.toString(), priceWeth: valid ? Number(sq) / Number(Q192) : 0,
    moveBps, high1hSq: highSq.toString(), low24hSq: lowSq.toString(), low24hTs: lowTs,
    buckets, tape,
    dipFromHighPct: r(dipBps / 100, 100), aboveLowPct: r(aboveLowPct, 100),
    quietTicks, dead: quietTicks >= DEAD_TICKS,
    externalSwaps1h: extHist.reduce((a, b) => a + b, 0), externalSwapsHist: extHist,
    historyTicks, historyReady: historyTicks >= 10,
    launchHighSq, firstSeenTs: prev?.firstSeenTs || now,
  };
}

async function loadFleet() {
  if (process.env.FLEET_ADDRESSES) return new Set(process.env.FLEET_ADDRESSES.split(',').map((a) => a.trim().toLowerCase()));
  try { const { BURNERS } = await import('../worker.js'); return new Set(BURNERS.map((a) => a.toLowerCase())); }
  catch { return new Set(); }
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n, d) => { const ix = args.indexOf(n); return ix >= 0 && args[ix + 1] ? args[ix + 1] : d; };
  const watchlistPath = getArg('--watchlist', './watchlist.json');
  const outPath = getArg('--out', './market-snapshot.json');
  const dryRun = args.includes('--dry-run');
  const RPC_URLS = (process.env.RPC_URLS || 'https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const log = (m) => console.log(m);
  const t0 = Date.now();
  let reqCount = 0;

  if (!existsSync(watchlistPath)) { console.error(`FATAL: watchlist not found: ${watchlistPath}`); process.exit(2); }
  const watchlist = JSON.parse(readFileSync(watchlistPath, 'utf8'));
  const banned = new Set((watchlist.banned || []).map((b) => b.address.toLowerCase()));
  const coins = (watchlist.coins || []).filter((c) => !banned.has(c.address.toLowerCase()));
  if (!coins.length) { console.error('FATAL: watchlist has no (unbanned) coins'); process.exit(2); }
  const fleet = await loadFleet();

  let prevSnap = null;
  if (existsSync(outPath)) { try { prevSnap = JSON.parse(readFileSync(outPath, 'utf8')); } catch { /* fresh */ } }
  let kv = null;
  if (process.env.KV_FILE && existsSync(process.env.KV_FILE)) {
    const { LocalKV } = await import('./kv-local.mjs');
    kv = new LocalKV(process.env.KV_FILE);
    try { const s = await kv.get('market:snapshot'); if (s) prevSnap = JSON.parse(s); } catch { /* ignore */ }
  }

  const now = Date.now();
  const pids = coins.map((c) => poolIdFor(c.address, c.poolKey));
  // Batch 1: every slot0 + the block number, one HTTP request.
  const b1 = await firstWorking(RPC_URLS, [
    ...coins.map((c, ix) => ({ method: 'eth_call', params: [{ to: STATEVIEW,
      data: encodeFunctionData({ abi: STATEVIEW_ABI, functionName: 'getSlot0', args: [pids[ix]] }) }, 'latest'] })),
    { method: 'eth_blockNumber', params: [] },
  ], 'price batch', log).catch((e) => { console.error(`FATAL: price batch: ${e.message}`); process.exit(1); });
  reqCount++;
  const curBlock = BigInt(b1.result[coins.length]);

  // Batch 2: ONE getLogs for PoolManager, filtered locally (address-only: some RPCs
  // reject topic arrays).
  let logs = null;
  try {
    const r = await firstWorking(RPC_URLS, [{ method: 'eth_getLogs',
      params: [{ address: POOLMANAGER, fromBlock: '0x' + (curBlock - BigInt(SWAP_LOOKBACK_BLOCKS)).toString(16), toBlock: '0x' + curBlock.toString(16) }] }], 'logs', log);
    logs = r.result[0]; reqCount++;
  } catch { log('WARNING: getLogs failed — tape UNKNOWN this tick (tape.ok=false)'); }

  const pidIx = new Map(pids.map((p, ix) => [p.toLowerCase(), ix]));
  const ours = (logs || []).filter((l) => l.topics?.[0]?.toLowerCase() === SWAP_TOPIC0 && pidIx.has(l.topics[1]?.toLowerCase()));
  // Batch 3: tx.from for our pools' swaps (the real trader, not the router).
  const froms = new Map();
  const hashes = [...new Set(ours.map((l) => l.transactionHash))].slice(0, MAX_TX_LOOKUPS);
  if (hashes.length) {
    try {
      const r = await firstWorking(RPC_URLS, hashes.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })), 'tx lookup', log);
      reqCount++;
      r.result.forEach((tx, k) => { if (tx?.from) froms.set(hashes[k], tx.from); });
    } catch { log('WARNING: tx lookups failed — external/fleet split unknown this tick'); }
  }

  const snapshot = { ts: now, coins: {} };
  coins.forEach((c, ix) => {
    let sq = 0n;
    try { const raw = b1.result[ix]; if (raw && raw !== '0x') sq = coinPriceSq(BigInt(raw.slice(0, 66)), c.address); } catch { /* invalid */ }
    const swaps = ours.filter((l) => l.topics[1].toLowerCase() === pids[ix].toLowerCase()).map((l) => ({
      ...decodeSwap(l, c.address), from: froms.get(l.transactionHash) || null, block: BigInt(l.blockNumber),
    }));
    snapshot.coins[c.address] = buildCoinEntry({ coin: c.address, name: c.name, pid: pids[ix], sq,
      prev: prevSnap?.coins?.[c.address], swaps, fleet, now, curBlock, tapeOk: logs !== null });
  });
  snapshot.meta = { coinCount: coins.length, httpRequests: reqCount, elapsedMs: Date.now() - t0 };

  if (!dryRun) {
    writeFileSync(outPath, JSON.stringify(snapshot));
    if (kv) await kv.put('market:snapshot', JSON.stringify(snapshot));
  }
  log(`=== watcher: ${coins.length} coins, ${reqCount} HTTP requests, ${snapshot.meta.elapsedMs}ms ===`);
  for (const s of Object.values(snapshot.coins)) {
    log(`  ${s.name}: price=${s.priceWeth.toExponential(3)} move=${(s.moveBps / 100).toFixed(2)}% ext=${s.tape.externalSwaps} swaps/${s.tape.externalTraders} traders fleet=${s.tape.fleetSwaps} dead=${s.dead} valid=${s.valid}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
