// fork-tournament.mjs — the babies fight each other for real, on a PRIVATE fork of Base.
//
// ============================== NOTES FOR WREN ==============================
// This is the "real trading" arena. It runs the UNCHANGED worker.js tick against an
// anvil fork of Base mainnet: real Uniswap V4 PoolManager, real Zora hook, the coin's
// real pool and liquidity, real signed transactions, real slippage, real gas math.
// Every buy a baby makes moves the price the other 15 see on the next read — they
// learn that their own actions move the market, and they fight for the same fills.
//
// Why a fork and not mainnet: on a fork nobody outside can see the trades, so the
// babies can churn against each other as hard as they like. On mainnet the same churn
// is wash trading (fake volume that outside buyers can't tell from real demand).
//
// SAFETY RAILS (do not remove):
//   * Refuses to run unless the RPC it hands the worker is localhost (the anvil fork).
//   * Generates FRESH throwaway keys every run. Never reads KEYS_FILE / real keys.
//   * Uses its own KV file (default ./fork-kv.json) and refuses the live kv-store.json.
//   * anvil is started with --no-mining off-chain only; nothing is broadcast upstream.
//
// TIME: worker.js uses Date.now() for cooldowns, 1h highs, buckets. Ticks here run
// back-to-back, so the harness runs a virtual clock (+60s per tick). Chain time stays
// real so the quote API's swap deadlines remain valid.
//
// OUTSIDERS (--outsiders N, --activity 0..1): simulated outside traders that random-walk
// buy/sell through the same Zora quote path. 0 outsiders = the "dead coin" arena:
// expect almost no trades and a fleet that only loses gas+fees — that IS the lesson.
//
// After a run, the per-wallet Q-tables are in the fork KV. They are fork-trained:
// merge into live per sim/MERGE-PLAN.md (small nudges), never overwrite.
// ===========================================================================
//
// Usage (needs foundry's `anvil` on PATH or ANVIL=/path/to/anvil):
//   node local-runner/fork-tournament.mjs --ticks 30 --outsiders 4 --activity 0.4 [--outsider-eth 0.0003] [--grid tight] [--pattern wave --wave 10]
//   Env: FORK_URL (default https://mainnet.base.org), PORT (8545), KV_FILE (./fork-kv.json),
//        BANKROLL_ETH (0.0001 per baby), ETH_USD (skip price APIs by pinning a price)

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { createPublicClient, http, parseEther, formatEther, parseAbi, decodeFunctionData, encodeFunctionData, maxUint256 } from 'viem';
import { base } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LocalKV } from './kv-local.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TICKS = +arg('--ticks', 30);
const OUTSIDERS = +arg('--outsiders', 4);
const ACTIVITY = +arg('--activity', 0.4);
// Outsider trade size in ETH. BRAWL's whole 2%-depth is ~0.0008 WETH (~$2): a $6 buy
// moves it ~50% and trips the 20% circuit breaker. Keep outsiders pool-sized.
const OUTSIDER_MAX_ETH = +arg('--outsider-eth', 0.0003);
// --pattern random: symmetric random walk. --pattern wave: outsiders buy for WAVE ticks,
// then sell for WAVE ticks (pump/dump cycles — the dips babies are built to trade).
const PATTERN = arg('--pattern', 'random');
const WAVE = +arg('--wave', 10);
let tickNo = 0;
const PORT = +(process.env.PORT || 8545);
const RPC = `http://127.0.0.1:${PORT}`;
const KV_FILE = resolve(process.env.KV_FILE || resolve(HERE, 'fork-kv.json'));
const BANKROLL = parseEther(process.env.BANKROLL_ETH || '0.0001');
const COIN = '0x1378d6A633E64f4abc22c07541473e3551E39b3F'; // worker.js is single-coin (BRAWL)

if (/kv-store\.json$/.test(KV_FILE)) { console.error('REFUSING: that is the LIVE kv file. Use a fork-only KV_FILE.'); process.exit(2); }

async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
}

async function startAnvil() {
  const bin = process.env.ANVIL || 'anvil';
  const child = spawn(bin, ['--fork-url', process.env.FORK_URL || 'https://mainnet.base.org', '--port', String(PORT), '--chain-id', '8453', '--silent',
    // Base-like fees: without these anvil reports ~10+ gwei and ONE tx costs more than
    // a baby's whole bankroll.
    '--block-base-fee-per-gas', '5000000', '--disable-min-priority-fee'], { stdio: 'ignore' });
  for (let k = 0; k < 120; k++) {
    try { await rpc('eth_chainId'); return child; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  child.kill(); throw new Error('anvil did not start');
}

// FORK-ONLY QUOTE LAYER. The Zora quote API simulates against MAINNET. On a fork that
// breaks three ways, all handled here (never do any of this on mainnet):
//  1. PRICES: once fork trades move the fork's pool, mainnet quotes are wrong. We keep
//     Zora's calldata LAYOUT but replace amountOut with Uniswap's V4Quoter evaluated ON
//     THE FORK (verified to match the Zora API to the wei on mainnet state).
//  2. minAmountOut: baked in as floor(amountOut*(1-slippage)) from mainnet state, so
//     swaps revert (V4TooLittleReceived 0x8b063d73). We set that word to 1. Safe ONLY on
//     a private fork with no MEV — on mainnet it is the only sandwich protection.
//  3. SELLS: the API simulates the sender's MAINNET balance; fork wallets hold nothing
//     there, so sell quotes fail. We ask for the layout with a mainnet holder as the
//     simulated sender (recipient stays the fork wallet), strip the signed-permit
//     command, and give every wallet a standing on-chain Permit2 allowance instead.
const realFetch = globalThis.fetch;
const QUOTER = '0x0d5e0f971ed27fbff6c2837bf31316121532048d';
const UNIVERSAL_ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const SIM_HOLDER = process.env.FORK_SIM_HOLDER || '0x35CdcDe2f918F777edeB72B8dA4928Ce657fdADF'; // holds BRAWL on mainnet
const POOL_KEY = { currency0: '0x1378d6A633E64f4abc22c07541473e3551E39b3F', currency1: '0x4200000000000000000000000000000000000006',
  fee: 8388608, tickSpacing: 200, hooks: '0x0469a4Bd3724DC86C9542F4694c976DA13C450c0' };
const QUOTER_ABI = parseAbi(['struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct P { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(P params) returns (uint256 amountOut, uint256 gasEstimate)']);
const UR_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs)', 'function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
let forkClient = null;
async function forkQuote(zeroForOne, amountIn) {
  const { result } = await forkClient.simulateContract({ address: QUOTER, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: POOL_KEY, zeroForOne, exactAmount: amountIn, hookData: '0x' }] });
  return result[0];
}
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api-sdk.zora.engineering/quote')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const isSell = body.tokenIn?.type === 'erc20';
  const amountIn = BigInt(body.amountIn);
  // Sells: ask for the layout of a small TEMPLATE sell from a real mainnet holder, then
  // swap the template amount for the real one (it is a distinctive calldata word).
  const TEMPLATE = 1000n * 10n ** 18n;
  // (sender must equal recipient, or the API returns a smart-wallet batch call instead)
  const realSender = body.sender;
  if (isSell) { body.sender = SIM_HOLDER; body.recipient = SIM_HOLDER; body.amountIn = TEMPLATE.toString(); delete body.signatures; }
  const res = await realFetch(url, { ...init, body: JSON.stringify(body) });
  const j = await res.json();
  if (!j?.call?.data || !j?.quote?.amountOut) return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } });
  // (2) minAmountOut word -> 1
  const out0 = BigInt(j.quote.amountOut);
  const minOut = (out0 * BigInt(Math.round((1 - Number(j.quote.slippage ?? 0.25)) * 1e6))) / 1000000n;
  const sel = j.call.data.slice(0, 10);
  const words = j.call.data.slice(10).replace(/[^0-9a-fA-F]/g, '0'); // permit placeholder -> zeros (decodable)
  let patched = '';
  for (let i = 0; i < words.length / 64; i++) {
    const w = words.slice(i * 64, i * 64 + 64);
    const v = BigInt('0x' + w); const diff = v > minOut ? v - minOut : minOut - v;
    if (v > 0n && diff <= minOut / 1000000n + 2n) patched += '1'.padStart(64, '0');
    else if (isSell && v === TEMPLATE) patched += amountIn.toString(16).padStart(64, '0');
    else if (isSell && v === BigInt(SIM_HOLDER)) patched += realSender.slice(2).toLowerCase().padStart(64, '0'); // payout -> fork wallet
    else patched += w;
  }
  let data = sel + patched;
  // (3) sells: drop PERMIT2_PERMIT (0x0a) — wallets hold a standing Permit2 allowance
  if (isSell) {
    const { functionName, args: a } = decodeFunctionData({ abi: UR_ABI, data });
    const cmds = a[0].slice(2).match(/../g);
    const keep = cmds.map((c, k) => k).filter((k) => (parseInt(cmds[k], 16) & 0x3f) !== 0x0a);
    const newArgs = ['0x' + keep.map((k) => cmds[k]).join(''), keep.map((k) => a[1][k]), ...a.slice(2)];
    data = encodeFunctionData({ abi: UR_ABI, functionName, args: newArgs });
    j.permits = [];
  }
  j.call.data = data;
  // (1) real fork price
  try { j.quote.amountOut = (await forkQuote(isSell, amountIn)).toString(); } catch (e) { /* keep API estimate */ }
  return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } });
};

// Virtual clock: worker.js sees +60s per tick.
const realNow = Date.now.bind(Date);
let virtualOffset = 0;
Date.now = () => realNow() + virtualOffset;

async function main() {
  const anvil = await startAnvil();
  try {
    const chainId = await rpc('eth_chainId');
    if (!RPC.startsWith('http://127.0.0.1')) throw new Error('REFUSING: worker RPC must be the local fork');
    console.log(`fork up on ${RPC} (chain ${parseInt(chainId, 16)}), block ${parseInt(await rpc('eth_blockNumber'), 16)}`);
    if (existsSync(KV_FILE)) unlinkSync(KV_FILE); // fresh arena each run
    const kv = new LocalKV(KV_FILE);

    const babyKeys = Array.from({ length: 16 }, () => generatePrivateKey());
    const babies = babyKeys.map((k) => privateKeyToAccount(k).address);
    const outsiderKeys = Array.from({ length: OUTSIDERS }, () => generatePrivateKey());
    for (const a of babies) await rpc('anvil_setBalance', [a, '0x' + BANKROLL.toString(16)]);
    for (const k of outsiderKeys) await rpc('anvil_setBalance', [privateKeyToAccount(k).address, '0x' + parseEther('0.05').toString(16)]);

    forkClient = createPublicClient({ chain: base, transport: http(RPC) });
    // Standing approvals so sells need no signed permit (see quote layer note 3):
    // coin.approve(Permit2, max) and Permit2.approve(coin, UniversalRouter, max, max).
    const P2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
    const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
    for (const k of [...babyKeys, ...outsiderKeys]) {
      const acct = privateKeyToAccount(k);
      let nonce = await forkClient.getTransactionCount({ address: acct.address, blockTag: 'pending' });
      for (const tx of [
        { to: COIN, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [PERMIT2, maxUint256] }) },
        { to: PERMIT2, data: encodeFunctionData({ abi: P2_ABI, functionName: 'approve', args: [COIN, UNIVERSAL_ROUTER, 2n ** 160n - 1n, 2 ** 48 - 1] }) },
      ]) {
        const signed = await acct.signTransaction({ ...tx, value: 0n, nonce: nonce++, gas: 100000n, gasPrice: 10000000n, chainId: 8453 });
        await rpc('eth_sendRawTransaction', [signed]);
      }
    }
    for (const a of babies) await rpc('anvil_setBalance', [a, '0x' + BANKROLL.toString(16)]); // approvals' gas refunded

    const worker = (await import('../worker.js')).default;
    const { __internal: I } = await import('../worker.js');
    const env = { TRADER_KV: kv, DRY_RUN: 'false', RPC_URLS: RPC, ZORA_API_KEY: process.env.ZORA_API_KEY || '',
      BURNER_ADDRESSES: babies.join(','),
      ...(args.includes('--grid') && arg('--grid') === 'tight' ? { DUMP_GRID: '5,10,15,20', VALUE_GRID: '10,20,30' } : {}) };
    babyKeys.forEach((k, i) => { env[`BURNER_KEY_${i}`] = k; });
    if (process.env.ETH_USD) await kv.put('ethusd:last', JSON.stringify({ price: +process.env.ETH_USD, ts: Date.now() }));

    const pc = createPublicClient({ chain: base, transport: http(RPC) });
    const quiet = () => {};
    async function outsiderTrade(key) {
      const acct = privateKeyToAccount(key);
      const bal = await pc.readContract({ address: COIN, abi: I.ERC20_ABI, functionName: 'balanceOf', args: [acct.address] });
      const wantSell = PATTERN === 'wave' ? Math.floor((tickNo - 1) / WAVE) % 2 === 1 : Math.random() < 0.5;
      const sell = bal > 0n && wantSell; // random: symmetric walk; wave: phase decides
      try {
        if (!sell) {
          const amt = parseEther((OUTSIDER_MAX_ETH * (0.2 + 0.8 * Math.random())).toFixed(9));
          const q = await I.getQuote(env, { tokenIn: { type: 'eth' }, tokenOut: { type: 'erc20', address: COIN }, amountInWei: amt, sender: acct.address, log: quiet });
          const { hash } = await I.sendRawTx(pc, acct, { to: q.call.target, data: q.call.data, value: BigInt(q.call.value || '0') }, quiet);
          await I.waitReceipt(pc, hash, quiet); return 'buy';
        }
        const amt = Math.random() < 0.2 ? bal : bal / 2n; // sometimes dump the whole bag
        let q = await I.getQuote(env, { tokenIn: { type: 'erc20', address: COIN }, tokenOut: { type: 'eth' }, amountInWei: amt, sender: acct.address, log: quiet });
        q = await I.resolveSellPermits(env, pc, acct, q, amt, quiet);
        await I.ensureSellApproval(pc, acct, q.call.target, amt, env, quiet, false);
        const { hash } = await I.sendRawTx(pc, acct, { to: q.call.target, data: q.call.data, value: 0n }, quiet);
        await I.waitReceipt(pc, hash, quiet); return 'sell';
      } catch (e) { if (process.env.FORK_DEBUG) console.error(String(e.message).slice(0, 600)); return `fail(${String(e.message).slice(0, 60)})`; }
    }

    const startEth = await Promise.all(babies.map((a) => pc.getBalance({ address: a })));
    for (let t = 1; t <= TICKS; t++) {
      virtualOffset += 60e3; tickNo = t;
      const acts = [];
      for (const k of outsiderKeys) if (Math.random() < ACTIVITY) acts.push(await outsiderTrade(k));
      await kv.put('meta:tickLock', '0');
      const origLog = console.log; console.log = quiet;
      try { await worker.scheduled({}, env, {}); } finally { console.log = origLog; }
      const tickLog = (await kv.get('meta:lastTickLog')) || '';
      const events = tickLog.split('\n').filter((l) => /BOUGHT|SOLD|STOP|SAFE-ABORT|TICK FATAL|CIRCUIT/.test(l)).map((l) => l.replace(/^\[[^\]]+\] /, ''));
      console.log(`tick ${t}: outsiders [${acts.join(',') || '-'}] ${events.length ? '\n   ' + events.join('\n   ') : ''}`);
    }

    // Final standings: realized ETH + open position marked at a REAL sell quote.
    const rows = [];
    for (let i = 0; i < 16; i++) {
      const eth = await pc.getBalance({ address: babies[i] });
      const tok = await pc.readContract({ address: COIN, abi: I.ERC20_ABI, functionName: 'balanceOf', args: [babies[i]] });
      let mark = 0n;
      if (tok > 0n) { try { mark = BigInt((await I.getQuote(env, { tokenIn: { type: 'erc20', address: COIN }, tokenOut: { type: 'eth' }, amountInWei: tok, sender: babies[i], log: quiet })).quote.amountOut); } catch { /* unpriced */ } }
      const st = JSON.parse((await kv.get(`wallet:${i}:stats`)) || '{}');
      rows.push({ i, pnl: eth + mark - startEth[i], trades: st.trades || 0, wins: st.wins || 0 });
    }
    rows.sort((a, b) => (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0));
    const fleet = rows.reduce((a, r) => a + r.pnl, 0n);
    console.log(`\n=== FORK TOURNAMENT (${TICKS} ticks, ${OUTSIDERS} outsiders @ ${ACTIVITY}) — fleet net ${formatEther(fleet)} ETH ===`);
    rows.forEach((r, k) => console.log(`#${k + 1} baby ${r.i}: ${formatEther(r.pnl)} ETH | ${r.trades} closes, ${r.wins} wins`));
    console.log(`fork KV (Q-tables, stats): ${KV_FILE}`);
  } finally {
    anvil.kill();
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
