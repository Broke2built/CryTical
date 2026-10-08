// Durable Object mode: same trading behavior on DO storage, plus the control surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import { DOStorageKV, TraderDO } from '../src/durable.js';
import { BURNERS } from '../worker.js';
import { FakeDOStorage } from './helpers/fake-do.mjs';
import { FakeChain, sqFor } from './helpers/fake-chain.mjs';
import { runScenarios } from './golden/scenarios.mjs';

// DOStorageKV + the MemKV helpers the scenarios use (set / json / m).
class DOKVWithHelpers extends DOStorageKV {
  constructor() { const s = new FakeDOStorage(); super(s); this.m = s.m; }
  set(k, v) { this.m.set(k, JSON.stringify(v)); }
  json(k) { const v = this.m.get(k); return v == null ? null : JSON.parse(v); }
}

test('DO storage adapter: golden master is byte-identical on Durable Object storage', async () => {
  const want = JSON.parse(readFileSync(new URL('./golden/recording.json', import.meta.url), 'utf8'));
  const got = JSON.parse(JSON.stringify(await runScenarios({ makeKV: () => new DOKVWithHelpers() })));
  for (let k = 0; k < want.length; k++) {
    assert.deepEqual(got[k].sent, want[k].sent, `${want[k].label}: transactions`);
    assert.deepEqual(got[k].state, want[k].state, `${want[k].label}: state`);
    // Wallets in a batch run concurrently, so lines from DIFFERENT wallets may interleave
    // differently (DO storage adds an async hop). Each wallet's own sequence, and the
    // fleet-level lines, must still be identical and in order.
    const byWallet = (lines) => { const g = {}; for (const l of lines) { const w = (l.match(/\] \[w(\d+)\]/) || [, 'fleet'])[1]; (g[w] ||= []).push(l); } return g; };
    assert.deepEqual(byWallet(got[k].logs), byWallet(want[k].logs), `${want[k].label}: logs`);
  }
});

function makeDO(extraEnv = {}) {
  const storage = new FakeDOStorage();
  const env = { DRY_RUN: 'false', RPC_URLS: 'http://fake-rpc', ZORA_API_KEY: 'x', TICK_TOKEN: 'secret', ...extraEnv };
  BURNERS.forEach((_, i) => { env[`BURNER_KEY_${i}`] = generatePrivateKey(); });
  return { dobj: new TraderDO({ storage }, env), storage };
}
const req = (path, method = 'GET', token = 'secret', body) => new Request(`https://fleet${path}`, {
  method, headers: token ? { 'x-tick-token': token, 'content-type': 'application/json' } : {}, body });
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };

test('DO alarm: runs a tick, records a heartbeat, re-arms ~60s after the tick started', async () => {
  const chain = new FakeChain({ priceWeth: 1e-8 }).install();
  try {
    const { dobj, storage } = makeDO();
    const t0 = Date.now();
    await quiet(() => dobj.alarm());
    const hb = JSON.parse(storage.m.get('meta:heartbeat'));
    assert.equal(hb.ticks, 1);
    assert.equal(hb.lastExit, 0);
    assert.ok(storage.alarm >= t0 + 60000 && storage.alarm <= Date.now() + 60000, 'next alarm one interval after start');
    assert.match(storage.m.get('meta:recentLog'), /tick exit=0/);
    assert.ok(storage.m.get('price:tick'), 'trading state written to DO storage');
  } finally { chain.uninstall(); }
});

test('DO: a tick never overlaps another; pause stops ticks but keeps the alarm armed', async () => {
  const chain = new FakeChain({ priceWeth: 1e-8 }).install();
  try {
    const { dobj, storage } = makeDO();
    dobj.running = true;
    assert.deepEqual(await dobj.runOnce('manual'), { skipped: 'a tick is already running' });
    dobj.running = false;
    assert.equal((await dobj.fetch(req('/pause', 'POST'))).status, 200);
    await quiet(() => dobj.alarm());
    assert.equal(storage.m.get('meta:heartbeat'), undefined, 'no tick while paused');
    assert.ok(storage.alarm, 'alarm still re-armed while paused');
    await dobj.fetch(req('/resume', 'POST'));
    await quiet(() => dobj.alarm());
    assert.equal(JSON.parse(storage.m.get('meta:heartbeat')).ticks, 1);
  } finally { chain.uninstall(); }
});

test('DO control surface: token required; health shape; export/import round-trip', async () => {
  const { dobj } = makeDO();
  assert.equal((await dobj.fetch(req('/health', 'GET', null))).status, 403);
  assert.equal((await dobj.fetch(req('/health', 'GET', 'wrong'))).status, 403);
  const noToken = new TraderDO({ storage: new FakeDOStorage() }, {});
  assert.equal((await noToken.fetch(req('/export'))).status, 403, 'no TICK_TOKEN configured -> admin disabled');
  const imp = await dobj.fetch(req('/import', 'POST', 'secret', JSON.stringify({ 'wallet:0:position': '{"amountWei":"5"}', bad: 7 })));
  assert.deepEqual(await imp.json(), { imported: 1 });
  const h = await (await dobj.fetch(req('/health'))).json();
  assert.equal(h.mode, 'cloudflare');
  assert.deepEqual(Object.keys(h.positions), ['wallet:0:position']);
  const ex = await (await dobj.fetch(req('/export'))).json();
  assert.equal(ex['wallet:0:position'], '{"amountWei":"5"}');
  assert.equal((await dobj.fetch(req('/status', 'GET', null))).status, 200, '/status stays public');
});
