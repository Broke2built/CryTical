// End-to-end: real worker.js ticks against FakeChain. Proves a VALUE buy is
// credited to the GRID combo the bandit picked (not an NN-sized off-grid key),
// the write-ahead record is consumed, and a profitable close updates exactly that
// Q cell. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey } from 'viem/accounts';
import worker, { BURNERS, __test } from '../worker.js';
import { FakeChain, MemKV, sqFor } from './helpers/fake-chain.mjs';

const W0 = BURNERS[0];
const quiet = { log() {}, error() {} };

async function tick(env) {
  env.TRADER_KV.set('meta:tickLock', 0); // tests run ticks back-to-back
  const orig = console.log; console.log = quiet.log;
  try { await worker.scheduled({}, env, {}); } finally { console.log = orig; }
  return env.TRADER_KV.m.get('meta:lastTickLog') || '';
}

test('value buy -> on-grid credit -> profitable close updates that Q cell', async () => {
  const price = 1e-8;
  const chain = new FakeChain({ priceWeth: price }).install();
  try {
    chain.eth.set(W0.toLowerCase(), 10n ** 15n); // 0.001 ETH; every other wallet is empty
    const kv = new MemKV();
    const now = Date.now();
    // Market state: price is 90% below a 1h high printed 10 min ago, flat for 10 min.
    kv.set('price:high1h', { sq: sqFor(price * 10).toString(), ts: now - 10 * 60e3 });
    kv.set('price:tick', { sq: sqFor(price).toString(), ts: now - 60e3, prevMoveBps: 0 });
    kv.set('price:buckets', Array.from({ length: 10 }, (_, k) => ({ ts: now - (10 - k) * 60e3, sq: sqFor(price).toString() })));
    const env = { TRADER_KV: kv, DRY_RUN: 'false', RPC_URLS: 'http://fake-rpc', ZORA_API_KEY: 'x', BURNER_KEY_0: generatePrivateKey() };

    const log1 = await tick(env);
    assert.match(log1, /BUY SIGNAL — VALUE/, log1);
    assert.match(log1, /advisory only/, 'untrained NN must not veto or size');
    const pos = kv.json('wallet:0:position');
    assert.ok(pos, 'position recorded');
    const grid = __test.blankQTable();
    assert.ok(pos.comboKey in grid, `credit key ${pos.comboKey} must be a grid cell`);
    assert.equal(kv.json('wallet:0:pendingBuy'), null, 'write-ahead record consumed');
    assert.equal(chain.sent.filter((s) => s.kind === '0xb0').length, 1, 'exactly one buy (other wallets unfunded)');

    // Next tick: sell quotes 30% above cost -> clears both the gas bar and any margin.
    chain.sellQuoteMult = 1.3;
    kv.set('wallet:0:lastTrade', now - 3600e3);
    const log2 = await tick(env);
    assert.match(log2, /TARGET HIT/, log2);
    assert.equal(kv.json('wallet:0:position'), null, 'position closed');
    const q = JSON.parse(kv.m.get('wallet:0:qtable'));
    assert.ok(q[pos.comboKey] > 0, `Q[${pos.comboKey}] learned a positive value`);
    assert.equal(Object.keys(q).length, 433, 'no off-grid keys were created');
    const stats = kv.json('wallet:0:stats');
    assert.equal(stats.wins, 1);
  } finally { chain.uninstall(); }
});

test('cooldown no longer blocks exits on a holding wallet', async () => {
  const price = 1e-8;
  const chain = new FakeChain({ priceWeth: price }).install();
  try {
    const kv = new MemKV();
    const now = Date.now();
    chain.tokens.set(W0.toLowerCase(), 10n ** 22n); // 1e4 tokens * 1e-8 ETH * $3000 = $0.30 = cost basis
    chain.eth.set(W0.toLowerCase(), 10n ** 14n);
    kv.set('wallet:0:seed', { dip: 40, margin: 3, size: 70, cooldownMin: 10 });
    kv.set('wallet:0:qgridver', 10);
    kv.set('wallet:0:qtable', __test.blankQTable());
    kv.set('wallet:0:lastTrade', now - 60e3); // bought 1 min ago: every cd arm is still cooling
    kv.set('wallet:0:position', { buyCostUsd: 0.3, buyGasUsd: 0.0001, amountWei: (10n ** 22n).toString(),
      comboKey: '30_70_3_70_cd20', marginAtOpen: 3, sizeAtOpen: 70, buyTx: '0x', buyTs: now - 60e3 });
    kv.set('price:tick', { sq: sqFor(price).toString(), ts: now - 60e3, prevMoveBps: 0 });
    chain.sellQuoteMult = 0.5; // -50%: must trip the no-time-gate hard stop
    const env = { TRADER_KV: kv, DRY_RUN: 'false', RPC_URLS: 'http://fake-rpc', ZORA_API_KEY: 'x', BURNER_KEY_0: generatePrivateKey() };
    const log = await tick(env);
    assert.doesNotMatch(log, /\[w0\] cooldown/, log);
    assert.match(log, /HARD STOP/, log);
    assert.equal(kv.json('wallet:0:position'), null);
    const q = JSON.parse(kv.m.get('wallet:0:qtable'));
    assert.ok(q['30_70_3_70_cd20'] < 0, 'loss credited to the opening combo');
  } finally { chain.uninstall(); }
});

test('DRY_RUN never broadcasts', async () => {
  const price = 1e-8;
  const chain = new FakeChain({ priceWeth: price }).install();
  try {
    chain.eth.set(W0.toLowerCase(), 10n ** 15n);
    const kv = new MemKV();
    const now = Date.now();
    kv.set('price:high1h', { sq: sqFor(price * 10).toString(), ts: now - 10 * 60e3 });
    kv.set('price:tick', { sq: sqFor(price).toString(), ts: now - 60e3, prevMoveBps: 0 });
    const env = { TRADER_KV: kv, DRY_RUN: 'true', RPC_URLS: 'http://fake-rpc', ZORA_API_KEY: 'x', BURNER_KEY_0: generatePrivateKey() };
    await tick(env);
    assert.equal(chain.sent.length, 0);
  } finally { chain.uninstall(); }
});
