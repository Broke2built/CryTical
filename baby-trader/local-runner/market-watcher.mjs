// market-watcher.mjs — CENTRALIZED market data fetcher for the baby fleet.
//
// Anthony's infra reality check (2026-10-08): 16 babies x N coins x per-tick
// reads would melt the degraded egress proxy. So: ONE watcher pulls price +
// trade history for the covered coin set ONCE per tick and writes a shared
// snapshot. The 16 babies READ the snapshot — zero per-baby network calls for
// market data. Their only network calls are their own trades (quotes,
// broadcasts, own balance/allowance reads).
//
// Scaling: JSON-RPC batching means 2 HTTP requests per tick total —
//   Batch 1: getSlot0 for all coins (1 request)
//   Batch 2: getLogs (Swap events) for all coins (1 request)
// 5 coins = 2 requests. 20 coins = 2 requests. The bottleneck is response
// size, not request count.
//
// Usage:
//   node market-watcher.mjs [--watchlist path] [--out path] [--dry-run]
//   Defaults: watchlist ./watchlist.json, out ./market-snapshot.json
//
// Snapshot format (written to out path + KV `market:snapshot` when KV_FILE set):
//   { ts, coins: { addr: { priceSq, priceWeth, moveBps, high1hSq, low24hSq,
//     buckets: [{ts, sq}], tape: {buyVol, sellVol, buyCount, sellCount,
//     whaleNet, uniqueBuyers, lastSwapTs}, dipFromHighPct, aboveLowPct,
//     dead, lastMoveTs, poolId } } }

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { keccak256, encodeAbiParameters } from 'viem';
import { LocalKV } from './kv-local.mjs';

const WETH = '0x4200000000000000000000000000000000000006';
const STATEVIEW = '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71';
const POOLMANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const ZORA_HOOK = '0x0469a4Bd3724DC86C9542F4694c976DA13C450c0';
const SWAP_TOPIC0 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const SWAP_LOOKBACK_BLOCKS = 300; // ~10 min
const WHALE_UNITS = 1000000;      // single swap >1M token units = whale
const DEAD_MOVE_BPS = 50;         // <0.50% move = quiet
const DEAD_TICKS = 60;            // 60 quiet ticks = dead coin

const RPC_URLS = (process.env.RPC_URLS ||
  'https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org')
  .split(',').map(s => s.trim()).filter(Boolean);

// --- pool key derivation (standard Zora V4 coin pool) ---
function poolIdFor(coin) {
  const c0 = coin.toLowerCase() < WETH.toLowerCase() ? coin : WETH;
  const c1 = coin.toLowerCase() < WETH.toLowerCase() ? WETH : coin;
  return keccak256(
    encodeAbiParameters(
      [{ type: 'tuple', components: [
        { type: 'address', name: 'currency0' },
        { type: 'address', name: 'currency1' },
        { type: 'uint24', name: 'fee' },
        { type: 'int24', name: 'tickSpacing' },
        { type: 'address', name: 'hooks' },
      ] }],
      [[c0, c1, 8388608, 200, ZORA_HOOK]]
    )
  );
}

// --- raw JSON-RPC batch ---
let rpcId = 1;
async function rpcBatch(url, calls, timeoutMs = 25000) {
  const batch = calls.map(c => ({ jsonrpc: '2.0', id: rpcId++, method: c.method, params: c.params }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = await res.json();
    const byId = {};
    for (const r of (Array.isArray(out) ? out : [out])) byId[r.id] = r;
    return batch.map(b => {
      const r = byId[b.id];
      if (!r) throw new Error(`missing response for id ${b.id}`);
      if (r.error) throw new Error(`RPC error: ${JSON.stringify(r.error).slice(0, 120)}`);
      return r.result;
    });
  } finally {
    clearTimeout(timer);
  }
}

// We use viem for ABI encoding to avoid selector mistakes.
import { encodeFunctionData } from 'viem';
const STATEVIEW_ABI = [
  { name: 'getSlot0', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ] },
];

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n, d) => {
    const ix = args.indexOf(n);
    return ix >= 0 && args[ix + 1] ? args[ix + 1] : d;
  };
  const watchlistPath = getArg('--watchlist', './watchlist.json');
  const outPath = getArg('--out', './market-snapshot.json');
  const dryRun = args.includes('--dry-run');
  const kvFile = process.env.KV_FILE;

  const t0 = Date.now();
  let reqCount = 0;

  // --- load watchlist ---
  if (!existsSync(watchlistPath)) {
    console.error(`FATAL: watchlist not found: ${watchlistPath}`);
    process.exit(2);
  }
  const watchlist = JSON.parse(readFileSync(watchlistPath, 'utf8'));
  const coins = watchlist.coins || [];
  if (!coins.length) {
    console.error('FATAL: watchlist has no coins');
    process.exit(2);
  }
  console.log(`watching ${coins.length} coins`);

  // --- load previous snapshot for history/deltas ---
  let prevSnap = null;
  if (existsSync(outPath)) {
    try { prevSnap = JSON.parse(readFileSync(outPath, 'utf8')); } catch { /* fresh */ }
  }
  // Also try KV for prev (KV is authoritative when set)
  let kv = null;
  if (kvFile && existsSync(kvFile)) {
    kv = new LocalKV(kvFile);
    try {
      const kvSnap = await kv.get('market:snapshot');
      if (kvSnap) prevSnap = JSON.parse(kvSnap);
    } catch { /* ignore */ }
  }

  const now = Date.now();
  const poolIds = {};
  for (const c of coins) poolIds[c.address.toLowerCase()] = poolIdFor(c.address);

  // --- BATCH 1: getSlot0 for all coins (1 HTTP request) ---
  const priceCalls = coins.map(c => ({
    method: 'eth_call',
    params: [{
      to: STATEVIEW,
      data: encodeFunctionData({ abi: STATEVIEW_ABI, functionName: 'getSlot0', args: [poolIds[c.address.toLowerCase()]] }),
    }, 'latest'],
  }));

  let prices = null, lastErr = null;
  for (const url of RPC_URLS) {
    try {
      prices = await rpcBatch(url, priceCalls);
      reqCount++;
      console.log(`price batch: ${coins.length} coins, 1 HTTP request via ${url}`);
      break;
    } catch (e) { lastErr = e; console.log(`price batch failed on ${url}: ${e.message.slice(0, 80)}`); }
  }
  if (!prices) {
    console.error(`FATAL: all RPCs failed for price batch: ${lastErr?.message}`);
    process.exit(1);
  }

  // --- BATCH 2: getLogs (Swap events) for all coins (1 HTTP request) ---
  // We need current block first — get it in the same batch as a separate call.
  let curBlockHex = null;
  for (const url of RPC_URLS) {
    try {
      const [blk] = await rpcBatch(url, [{ method: 'eth_blockNumber', params: [] }]);
      curBlockHex = blk; reqCount++;
      break;
    } catch (e) { console.log(`blockNumber failed on ${url}: ${e.message.slice(0, 60)}`); }
  }
  const curBlock = curBlockHex ? parseInt(curBlockHex, 16) : 0;
  const fromBlock = '0x' + Math.max(0, curBlock - SWAP_LOOKBACK_BLOCKS).toString(16);

  const logCalls = coins.map(c => ({
    method: 'eth_getLogs',
    params: [{ address: POOLMANAGER, fromBlock, toBlock: 'latest' }],
  }));
  let logResults = null;
  for (const url of RPC_URLS) {
    try {
      logResults = await rpcBatch(url, logCalls);
      reqCount++;
      console.log(`logs batch: ${coins.length} coins, 1 HTTP request via ${url}`);
      break;
    } catch (e) { lastErr = e; console.log(`logs batch failed on ${url}: ${e.message.slice(0, 80)}`); }
  }
  // Logs are advisory — continue without tape if they fail
  if (!logResults) console.log('WARNING: getLogs failed on all RPCs — tape will be empty this tick');

  // --- build snapshot ---
  const snapshot = { ts: now, coins: {} };
  // getSlot0 returns 4 ABI words; sqrtPriceX96 is the first word (0x + 64 hex chars)
  const decodeUint160 = (hex) => BigInt(hex.slice(0, 66));

  coins.forEach((c, ix) => {
    const addr = c.address.toLowerCase();
    const pid = poolIds[addr];
    let sq = 0n, valid = false;
    try {
      const raw = prices[ix];
      if (raw && raw !== '0x') {
        const sqrtPx = decodeUint160(raw);
        if (sqrtPx > 0n) { sq = sqrtPx * sqrtPx; valid = true; }
      }
    } catch { /* invalid */ }

    const prev = prevSnap?.coins?.[c.address]?.buckets || [];
    const buckets = [...prev, { ts: now, sq: sq.toString() }].slice(-300);

    // move since last tick
    const prevTick = prevSnap?.coins?.[c.address];
    const prevSq = prevTick ? BigInt(prevTick.priceSq) : sq;
    const moveBps = (prevSq > 0n && sq > 0n)
      ? Number(((sq - prevSq) * 10000n) / prevSq) : 0;

    // 1h high / 24h low from buckets — with cold-start guard
    // On first sight, high/low initialize to current price. Signals that depend
    // on them (VALUE, BOTTOM) must NOT fire until we have real history.
    const hourAgo = now - 3600e3, dayAgo = now - 24 * 3600e3;
    let highSq = sq, lowSq = sq;
    let historyTicks = (prevTick?.historyTicks || 0) + 1;
    for (const b of buckets) {
      const bsq = BigInt(b.sq);
      if (bsq <= 0n) continue;
      if (b.ts >= hourAgo && bsq > highSq) highSq = bsq;
      if (b.ts >= dayAgo && (lowSq <= 0n || bsq < lowSq)) lowSq = bsq;
    }
    // Cold start: need at least 10 ticks before high/low signals are valid.
    // (Prevents the "everything is at the 24h low" false BOTTOM on first tick.)
    const historyReady = historyTicks >= 10;

    // dead detection: no 0.50%+ move in DEAD_TICKS
    const lastMoveTs = prevTick?.lastMoveTs || now;
    const newLastMove = Math.abs(moveBps) >= DEAD_MOVE_BPS ? now : lastMoveTs;
    const quietTicks = prevTick?.quietTicks || 0;
    const newQuiet = Math.abs(moveBps) >= DEAD_MOVE_BPS ? 0 : quietTicks + 1;
    const dead = newQuiet >= DEAD_TICKS;

    // tape from swap logs
    const tape = { buyVol: 0, sellVol: 0, buyCount: 0, sellCount: 0, whaleNet: 0, uniqueBuyers: [], lastSwapTs: 0 };
    if (logResults && logResults[ix]) {
      const buyers = new Set();
      for (const l of logResults[ix]) {
        if (!l.topics || l.topics[0]?.toLowerCase() !== SWAP_TOPIC0) continue;
        // poolId is topic[1]
        if (l.topics[1]?.toLowerCase() !== pid.toLowerCase()) continue;
        // decode amounts from data: amount0 (int128), amount1 (int128)
        try {
          const data = l.data.slice(2);
          const amount0 = BigInt('0x' + data.slice(0, 64));
          // sign-extend int128
          const signed0 = amount0 >= (1n << 127n) ? amount0 - (1n << 256n) : amount0;
          const units = Number(signed0 < 0 ? -signed0 : signed0) / 1e18;
          // amount0 < 0 → pool paid token0 out → trader BOUGHT token0
          // For coin/WETH pools, token0 is the coin if coin < WETH
          const coinIsT0 = c.address.toLowerCase() < WETH.toLowerCase();
          const traderBoughtCoin = coinIsT0 ? signed0 < 0 : signed0 > 0;
          if (traderBoughtCoin) { tape.buyVol += units; tape.buyCount++; }
          else { tape.sellVol += units; tape.sellCount++; }
          if (units > WHALE_UNITS) tape.whaleNet += traderBoughtCoin ? units : -units;
          // sender is topic[2] (address)
          if (l.topics[2]) {
            const sender = '0x' + l.topics[2].slice(-40);
            if (traderBoughtCoin) buyers.add(sender.toLowerCase());
          }
          const blockTs = parseInt(l.timeStamp || '0', 16) * 1000;
          if (blockTs > tape.lastSwapTs) tape.lastSwapTs = blockTs;
        } catch { /* skip malformed */ }
      }
      tape.uniqueBuyers = [...buyers].slice(0, 50); // cap
    }

    // dip metrics
    const dipBps = highSq > 0n ? Number(((highSq - sq) * 10000n) / highSq) : 0;
    const aboveLowPct = (lowSq > 0n && sq > lowSq) ? Number((sq - lowSq) * 10000n / lowSq) / 100 : 0;

    snapshot.coins[c.address] = {
      name: c.name || addr.slice(0, 10),
      poolId: pid,
      priceSq: sq.toString(),
      priceWeth: sq > 0n ? Number(sq) / Number(2n ** 192n) : 0,
      moveBps,
      high1hSq: highSq.toString(),
      low24hSq: lowSq.toString(),
      buckets: buckets.slice(-60), // keep snapshot lean; full history in KV
      tape: {
        buyVol: Math.round(tape.buyVol * 100) / 100,
        sellVol: Math.round(tape.sellVol * 100) / 100,
        buyCount: tape.buyCount,
        sellCount: tape.sellCount,
        whaleNet: Math.round(tape.whaleNet * 100) / 100,
        uniqueBuyerCount: tape.uniqueBuyers.length,
        lastSwapTs: tape.lastSwapTs,
      },
      dipFromHighPct: Math.round((dipBps / 100) * 100) / 100,
      aboveLowPct: Math.round(aboveLowPct * 100) / 100,
      dead,
      quietTicks: newQuiet,
      lastMoveTs: newLastMove,
      valid,
      historyTicks,
      historyReady, // false until 10+ ticks of price history observed
      // launch tracking for fresh-coin bootstrap
      launchHighSq: prevTick?.launchHighSq || (valid ? sq.toString() : null),
      firstSeenTs: prevTick?.firstSeenTs || now,
    };
    // update launch high
    const sc = snapshot.coins[c.address];
    if (valid && sc.launchHighSq && sq > BigInt(sc.launchHighSq)) {
      sc.launchHighSq = sq.toString();
    }
  });

  const elapsed = Date.now() - t0;
  snapshot.meta = {
    coinCount: coins.length,
    httpRequests: reqCount,
    elapsedMs: elapsed,
    rpcBatches: 2, // price + logs (+1 blockNumber)
  };

  if (!dryRun) {
    writeFileSync(outPath, JSON.stringify(snapshot));
    if (kv) {
      await kv.put('market:snapshot', JSON.stringify(snapshot));
      console.log('snapshot written to KV market:snapshot');
    }
  }

  console.log(`\n=== watcher complete: ${coins.length} coins, ${reqCount} HTTP requests, ${elapsed}ms ===`);
  for (const [addr, s] of Object.entries(snapshot.coins)) {
    console.log(`  ${s.name}: price=${s.priceWeth.toExponential(3)} move=${(s.moveBps/100).toFixed(2)}% tape=${s.tape.buyCount}B/${s.tape.sellCount}S dead=${s.dead} valid=${s.valid}`);
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
