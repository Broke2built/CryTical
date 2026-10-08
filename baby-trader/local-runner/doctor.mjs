// doctor.mjs — ONE command that says whether the babies are OK, and what to do if not.
//
//   npm run status -- --remote    # Cloudflare mode: ONE https call to your worker, ZERO RPC
//                                  # from this PC (needs WORKER_URL + TICK_TOKEN env vars)
//   npm run status                # local-runner mode: reads local files + 1 batched RPC call
//   npm run status -- --offline   # local-runner mode, no network at all
//   add --json for machine-readable output (for scheduled agents)
//
// Exit code: 0 = all good, 1 = warnings, 2 = something needs fixing now.
// Every problem prints a "FIX:" line with the exact thing to do. Safe to run any time,
// as often as you like: it never trades, never writes state, never moves funds.
//
// Env (same as the runner): KV_FILE, TICK_LOG, HEARTBEAT_FILE, RPC_URLS (first URL used).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESERVE_WEI = 50000000000000n; // worker.js GAS_RESERVE_WEI default

// ---- pure diagnosis (unit-tested) ----
// input: { now, heartbeat|null, logLines[], kv{}|null, lockPid|null, lockAlive, chain|null }
// chain: { tokens: bigint[16], eth: bigint[16] } or null when offline / failed
export function diagnose(x) {
  const out = [];
  const cf = x.mode === 'cloudflare';
  const RESTART = cf ? 'Run:  npm run ops -- ensure   (re-arms the Cloudflare alarm loop), then check again in 2 minutes. Still dead? npx wrangler tail' : 'Run:  pm2 restart babies   then run this again in 2 minutes. If it keeps happening: pm2 logs babies';
  if (x.paused) out.push({ level: 'warn', what: 'Trading is PAUSED (kill switch is on).', fix: 'When you want it back on:  npm run ops -- resume' });
  const add = (level, what, fix) => out.push({ level, what, fix });
  const hb = x.heartbeat;
  if (!hb) add('bad', 'No tick has ever finished — the bot is not running (or never started).',
    cf ? 'Run:  npm run ops -- ensure   (starts the alarm loop). Deployed yet? See RUN-IT.md step 3.' : 'Start it:  KEYS_FILE=... KV_FILE=... DRY_RUN=true pm2 start local-runner/loop.mjs --name babies   (see RUN-IT.md)');
  else {
    const ageMin = (x.now - hb.ts) / 60000;
    if (ageMin > 5 && !x.paused) add('bad', `No tick finished in ${ageMin.toFixed(0)} minutes — the bot is stopped or stuck.`, RESTART);
    else if (ageMin > 2.5) add('warn', `Last tick finished ${ageMin.toFixed(1)} min ago (normally < 2).`, 'Usually a slow network. Check again in a few minutes.');
    if (hb.consecutiveFails >= 3) add('bad', `The last ${hb.consecutiveFails} ticks failed (exit code ${hb.lastExit}).`,
      cf ? 'Look at the log:  npm run ops -- log   Most often: a missing secret (npx wrangler secret list).' : 'Look at the last lines of tick.log (pm2 logs babies). Most often: keys file path wrong, or KV file unreadable.');
  }
  const tail = x.logLines.slice(-400).join('\n');
  const count = (re) => (tail.match(re) || []).length;
  if (count(/KILLED \(hung/) > 0) add('bad', 'A tick hung for 15+ minutes and was killed.',
    'A trade may be half-finished. Run: npm run status (this) again — check the ORPHAN/GHOST lines below. If any: tell Wren/Claude before restarting live trading.');
  const safeAborts = count(/SAFE-ABORT/), lastTicks = Math.max(1, count(/tick exit=/));
  if (safeAborts >= 3) add(safeAborts >= lastTicks / 2 ? 'bad' : 'warn', `${safeAborts} recent ticks could not read the price (all RPCs failed). Babies are paused, not broken.`,
    'Check the internet connection. If it is fine, the free RPCs are rate-limiting you: put a keyed RPC (Alchemy/QuickNode free tier) FIRST in RPC_URLS and pm2 restart babies.');
  if (count(/ETH\/USD UNKNOWN/) >= 3) add('warn', 'ETH price lookups keep failing (coinbase/coingecko/kraken all down for you).', 'Usually the network. If it persists for an hour, tell Wren.');
  if (count(/kvPutCritical .* failed after/) > 0) add('bad', 'A position record failed to save after a trade.',
    'Disk full or KV file locked? Check free disk space. Then run this again — an ORPHAN line below means the wallet holds coins the bot does not know about (the bot reconciles it on the next tick).');
  if (count(/TICK FATAL/) > 0) add('bad', 'A tick crashed with an unexpected error.', 'Send the last 50 lines of tick.log to Wren/Claude.');
  if (count(/WALLET TIMEOUT/) >= 5) add('warn', `${count(/WALLET TIMEOUT/)} wallet timeouts recently — the network is slow.`, 'Nothing to do unless it keeps going for hours; then add a keyed RPC (see above).');
  if (count(/CIRCUIT BREAKER TRIPPED/) > 0) add('info', 'The circuit breaker tripped (price moved >20% in a minute). Trading pauses 5 min by design.', 'Nothing to do.');
  if (/DRY_RUN mode/.test(tail)) add('info', 'DRY_RUN is ON: the babies decide but never send transactions.',
    cf ? 'When ready to go live: set DRY_RUN = "false" in wrangler.toml and  npx wrangler deploy' : 'When you are ready to go live: restart without DRY_RUN=true.');
  if (x.lockPid && !x.lockAlive) add('info', 'A stale lock file from a crashed tick exists.', 'Nothing to do — the next tick removes it automatically.');

  if (x.kv) {
    const pos = (i) => { try { const v = x.kv[`wallet:${i}:position`]; return v && v !== 'null' ? JSON.parse(v) : null; } catch { return null; } };
    let holding = 0;
    const orphans = [], ghosts = [], noEth = [];
    for (let i = 0; i < 16; i++) {
      const p = pos(i);
      if (p) holding++;
      if (x.chain) {
        const onchain = x.chain.tokens[i], kvAmt = p ? BigInt(p.amountWei || '0') : 0n, DUST = 10n ** 18n;
        if (onchain > DUST && kvAmt <= DUST) orphans.push(`w${i}`);
        if (onchain <= DUST && kvAmt > DUST) ghosts.push(`w${i}`);
        if (x.chain.eth[i] <= RESERVE_WEI && !p) noEth.push(`w${i}`);
      }
    }
    if (orphans.length) add('warn', `${orphans.join(', ')}: hold coins onchain but the bot has no record (ORPHAN).`, 'Nothing to do — the next live tick adopts them automatically. Still here in 10 min? Tell Wren.');
    if (ghosts.length) add('warn', `${ghosts.join(', ')}: the bot thinks they hold coins, but the wallets are empty (GHOST).`, 'Nothing to do — the next live tick clears them. Still here in 10 min? Tell Wren.');
    if (noEth.length) add('warn', `${noEth.length === 16 ? 'All 16 wallets' : noEth.join(', ')}: out of ETH (at or below the gas reserve) — cannot buy.`, 'Send a little ETH on Base to the wallets you want trading.');
    add('info', `${holding}/16 babies holding a position.`, null);
  } else add('warn', cf ? 'Could not read the bot state from the worker.' : 'KV state file not found.', cf ? 'Check WORKER_URL and TICK_TOKEN.' : 'Set KV_FILE to the same path the runner uses.');
  if (x.chainError) add('warn', `Onchain check skipped: ${x.chainError}`, 'Network issue; the rest of this report is still valid.');
  return out;
}

// Public RPCs count every item in a batch against their rate limit (mainnet.base.org:
// 25/s), so send small chunks and fall back through RPC_URLS in order.
async function chainCheck(rpcs, burners, coin) {
  const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  const calls = burners.flatMap((a, i) => [
    { jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: coin, data: '0x70a08231' + pad(a) }, 'latest'] },
    { jsonrpc: '2.0', id: 100 + i, method: 'eth_getBalance', params: [a, 'latest'] },
  ]);
  let by = null, lastErr = 'no RPC';
  for (const rpc of rpcs) {
    try {
      const got = {};
      for (let k = 0; k < calls.length; k += 8) {
        const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.slice(k, k + 8)), signal: AbortSignal.timeout(20000) });
        const res = await r.json();
        for (const x of (Array.isArray(res) ? res : [])) if (x.result != null) got[x.id] = x.result;
      }
      if (Object.keys(got).length === calls.length) { by = got; break; }
      lastErr = `${rpc}: ${Object.keys(got).length}/${calls.length} answers`;
    } catch (e) { lastErr = `${rpc}: ${e.message}`; }
  }
  if (!by) throw new Error(lastErr);
  const tokens = burners.map((_, i) => { if (by[i] == null) throw new Error('incomplete RPC answer'); return BigInt(by[i]); });
  const eth = burners.map((_, i) => BigInt(by[100 + i] ?? '0x0'));
  return { tokens, eth };
}

async function remoteInput() {
  const url = (process.env.WORKER_URL || '').replace(/\/$/, '');
  if (!url || !process.env.TICK_TOKEN) { console.error('Set WORKER_URL (https://<your-worker>.workers.dev) and TICK_TOKEN first.'); process.exit(2); }
  const r = await fetch(`${url}/health${process.argv.includes('--offline') ? '' : '?chain=1'}`, { headers: { 'x-tick-token': process.env.TICK_TOKEN }, signal: AbortSignal.timeout(30000) });
  if (r.status === 403) { console.error('The worker refused the token (403). TICK_TOKEN here must match the worker secret.'); process.exit(2); }
  const h = await r.json();
  const chain = h.chain ? { tokens: h.chain.tokens.map((x) => BigInt(x)), eth: h.chain.eth.map((x) => BigInt(x)) } : null;
  return { mode: 'cloudflare', now: Date.now(), heartbeat: h.heartbeat, logLines: h.logLines || [], kv: h.positions || {}, paused: h.paused,
    lockPid: null, lockAlive: false, chain, chainError: h.chainError };
}

if (import.meta.url === `file://${process.argv[1]}`) {
 const remote = process.argv.includes('--remote');
 let input;
 if (remote) input = await remoteInput();
 else {
  const KV_FILE = resolve(process.env.KV_FILE || resolve(HERE, 'kv-store.json'));
  const LOG = resolve(process.env.TICK_LOG || resolve(HERE, 'tick.log'));
  const HB = resolve(process.env.HEARTBEAT_FILE || resolve(HERE, 'heartbeat.json'));
  const read = (f, d) => { try { return readFileSync(f, 'utf8'); } catch { return d; } };
  const heartbeat = (() => { try { return JSON.parse(read(HB, '')); } catch { return null; } })();
  const kv = (() => { try { return JSON.parse(read(KV_FILE, '')); } catch { return null; } })();
  const logLines = read(LOG, '').split('\n');
  let lockPid = null, lockAlive = false;
  if (existsSync(`${KV_FILE}.lock`)) {
    lockPid = parseInt(read(`${KV_FILE}.lock`, '0'), 10);
    try { process.kill(lockPid, 0); lockAlive = true; } catch (e) { lockAlive = e.code === 'EPERM'; }
  }
  let chain = null, chainError = null;
  if (!process.argv.includes('--offline')) {
    try {
      const { BURNERS, BRAWL } = await import('../worker.js');
      const rpcs = (process.env.RPC_URLS || 'https://base-rpc.publicnode.com,https://mainnet.base.org').split(',').map((s) => s.trim()).filter(Boolean);
      chain = await chainCheck(rpcs, BURNERS, BRAWL);
    } catch (e) { chainError = String(e.message || e).slice(0, 100); }
  }
  input = { mode: 'local', now: Date.now(), heartbeat, logLines, kv, lockPid, lockAlive, chain, chainError };
 }
  const { heartbeat } = input;
  const findings = diagnose(input);
  const bad = findings.filter((f) => f.level === 'bad'), warn = findings.filter((f) => f.level === 'warn');
  const head = bad.length ? '❌ NEEDS FIXING NOW' : warn.length ? '⚠️  RUNNING, WITH WARNINGS' : '✅ ALL GOOD';
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ status: bad.length ? 'bad' : warn.length ? 'warn' : 'ok', mode: input.mode, heartbeat, findings }, null, 1));
    process.exit(bad.length ? 2 : warn.length ? 1 : 0);
  }
  console.log(`\n${head}   (${new Date().toLocaleString()})`);
  if (heartbeat) console.log(`   last tick: ${Math.round((Date.now() - heartbeat.ts) / 1000)}s ago, ${heartbeat.ticks} ticks since start, last took ${(heartbeat.lastMs / 1000).toFixed(1)}s`);
  if (!remote) { const KV_FILE = resolve(process.env.KV_FILE || resolve(HERE, 'kv-store.json')); if (existsSync(KV_FILE)) console.log(`   state file: ${KV_FILE} (${(statSync(KV_FILE).size / 1024).toFixed(0)} KB)`); }
  let n = 0;
  for (const f of [...bad, ...warn, ...findings.filter((f) => f.level === 'info')]) {
    const icon = f.level === 'bad' ? '❌' : f.level === 'warn' ? '⚠️ ' : 'ℹ️ ';
    console.log(`\n${icon} ${f.what}`);
    if (f.fix) console.log(`   FIX ${++n}: ${f.fix}`);
  }
  console.log('');
  process.exit(bad.length ? 2 : warn.length ? 1 : 0);
}
