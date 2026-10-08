// Local-PC runner: KV durability, process lock, scheduler, and a Cloudflare budget
// regression guard (per-tick subrequests and KV ops measured on real worker ticks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { generatePrivateKey } from 'viem/accounts';
import { LocalKV } from '../local-runner/kv-local.mjs';
import worker, { BURNERS } from '../worker.js';
import { FakeChain, MemKV, sqFor } from './helpers/fake-chain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'lr-'));
const onDisk = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('LocalKV coalescing: critical keys hit disk immediately, others on flush()', async () => {
  const f = join(tmp(), 'kv.json');
  const kv = new LocalKV(f, { deferNonCritical: true });
  await kv.put('wallet:3:stats', '{"points":1}');
  assert.equal(existsSync(f), false, 'non-critical write deferred');
  await kv.put('wallet:3:position', '{"amountWei":"5"}');
  assert.equal(onDisk(f)['wallet:3:position'], '{"amountWei":"5"}', 'position durable before put() resolves');
  assert.equal(onDisk(f)['wallet:3:stats'], '{"points":1}', 'a critical flush also persists earlier writes');
  await kv.put('wallet:3:qtable', '{}');
  assert.equal(onDisk(f)['wallet:3:qtable'], undefined);
  kv.flush();
  assert.equal(onDisk(f)['wallet:3:qtable'], '{}');
  const wt = new LocalKV(join(tmp(), 'kv.json'));            // default = old write-through
  await wt.put('x', '1');
  assert.equal(onDisk(wt.filePath).x, '1');
});

test('run-tick process lock: a live lock skips the tick, a dead PID lock is taken over', () => {
  const dir = tmp();
  const kvFile = join(dir, 'kv.json');
  writeFileSync(join(dir, 'keys.json'), JSON.stringify({ BURNER_KEY_0: generatePrivateKey() }));
  const run = () => spawnSync(process.execPath, [resolve(HERE, '../local-runner/run-tick.mjs')], {
    env: { ...process.env, KEYS_FILE: join(dir, 'keys.json'), KV_FILE: kvFile, DRY_RUN: 'true',
      RPC_URLS: 'http://127.0.0.1:9', EGRESS_STATE_FILE: join(dir, 'none.json') }, encoding: 'utf8', timeout: 120000 });
  writeFileSync(`${kvFile}.lock`, String(process.pid)); // we are alive -> lock is held
  const held = run();
  assert.match(held.stdout, /tick skipped: another tick holds/);
  writeFileSync(`${kvFile}.lock`, '2147483646'); // no such PID -> stale
  const stale = run();
  assert.doesNotMatch(stale.stdout, /another tick holds/);
  assert.match(stale.stdout, /SAFE-ABORT|tick/); // ran (RPC unreachable -> safe abort, no trades)
  assert.equal(existsSync(`${kvFile}.lock`), false, 'lock released on exit');
});

test('loop.mjs: sequential ticks, monitor-compatible log lines, heartbeat', async () => {
  const dir = tmp();
  const env = { ...process.env, MAX_TICKS: '3', TICK_INTERVAL_MS: '50', TICK_LOG: join(dir, 'tick.log'),
    HEARTBEAT_FILE: join(dir, 'hb.json'), LOOP_TICK_CMD: JSON.stringify([process.execPath, '-e', 'console.log("ok")']) };
  const r = spawnSync(process.execPath, [resolve(HERE, '../local-runner/loop.mjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(join(dir, 'tick.log'), 'utf8').split('\n');
  const exits = lines.filter((l) => /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z tick exit=(\d+)/.test(l)); // baby-monitor's regex
  assert.equal(exits.length, 3);
  assert.equal(JSON.parse(readFileSync(join(dir, 'hb.json'), 'utf8')).ticks, 3);
});

test('loop.mjs watchdog kills a hung tick and logs it', async () => {
  const dir = tmp();
  const env = { ...process.env, MAX_TICKS: '1', TICK_HARD_KILL_MS: '300', TICK_LOG: join(dir, 'tick.log'),
    HEARTBEAT_FILE: join(dir, 'hb.json'), LOOP_TICK_CMD: JSON.stringify([process.execPath, '-e', 'setTimeout(()=>{}, 60000)']) };
  const r = spawnSync(process.execPath, [resolve(HERE, '../local-runner/loop.mjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0);
  assert.match(readFileSync(join(dir, 'tick.log'), 'utf8'), /tick exit=137 KILLED/);
});

// ---- Cloudflare budget guard (numbers in CLOUDFLARE-NOTES.md come from this) ----
class CountKV extends MemKV {
  constructor() { super(); this.gets = 0; this.puts = 0; }
  async get(k) { this.gets++; return super.get(k); }
  async put(k, v) { this.puts++; return super.put(k, v); }
}
test('per-tick budget: worst case (16 buys / 16 sells) stays under Workers Paid limits', async () => {
  const price = 1e-8, now = Date.now();
  const chain = new FakeChain({ priceWeth: price }).install();
  try {
    const kv = new CountKV();
    const env = { TRADER_KV: kv, DRY_RUN: 'false', RPC_URLS: 'http://fake-rpc', ZORA_API_KEY: 'x' };
    BURNERS.forEach((a, i) => { chain.eth.set(a.toLowerCase(), 10n ** 15n); env[`BURNER_KEY_${i}`] = generatePrivateKey(); });
    kv.set('price:high1h', { sq: sqFor(price * 10).toString(), ts: now - 10 * 60e3 });
    kv.set('price:tick', { sq: sqFor(price).toString(), ts: now - 60e3, prevMoveBps: 0 });
    const measure = async () => {
      kv.set('meta:tickLock', 0); kv.gets = 0; kv.puts = 0;
      const rpc0 = chain.calls.length; let http = 0; const of = globalThis.fetch;
      globalThis.fetch = async (u, i) => { if (!String(u).startsWith('http://fake-rpc')) http++; return of(u, i); };
      const ol = console.log; console.log = () => {};
      try { await worker.scheduled({}, env, {}); } finally { console.log = ol; globalThis.fetch = of; }
      return { sub: chain.calls.length - rpc0 + http, kvOps: kv.gets + kv.puts };
    };
    const buy = await measure();
    chain.sellQuoteMult = 1.3; for (let i = 0; i < 16; i++) kv.set(`wallet:${i}:lastTrade`, now - 3600e3);
    const sell = await measure();
    for (const [name, m] of [['buy', buy], ['sell', sell]]) {
      assert.ok(m.sub < 500, `${name}: ${m.sub} subrequests (Workers Paid cap 1000; keep 2x headroom for receipt polling)`);
      assert.ok(m.kvOps < 1000, `${name}: ${m.kvOps} KV ops (cap 1000 per invocation)`);
    }
  } finally { chain.uninstall(); }
});
