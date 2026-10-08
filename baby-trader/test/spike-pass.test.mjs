// Spike-pass fix tests (Wren 2026-10-08). The old pass sold EVERY holding wallet in
// one tick at just the 1.5x-gas bar. Now: (1) owner/fleet-driven spikes hold,
// (2) only wallets at their OWN target (max(1.5x gas, margin)) may spike-exit,
// (3) at most 4 spike exits per tick. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey } from 'viem/accounts';
import worker, { BURNERS, __internal } from '../worker.js';
import { FakeChain, MemKV, sqFor } from './helpers/fake-chain.mjs';

const W0 = BURNERS[0];
const SWAP_TOPIC0 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const quiet = { log() {}, error() {} };

async function tick(env) {
  env.TRADER_KV.set('meta:tickLock', 0); // tests run ticks back-to-back
  const orig = console.log; console.log = quiet.log;
  try { await worker.scheduled({}, env, {}); } finally { console.log = orig; }
  return env.TRADER_KV.m.get('meta:lastTickLog') || '';
}

// Full (untruncated) log capture: meta:lastTickLog keeps only the last 150 lines,
// which drops early-tick lines on busy ticks. This captures everything.
async function tickFull(env) {
  env.TRADER_KV.set('meta:tickLock', 0);
  const lines = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await worker.scheduled({}, env, {}); } finally { console.log = origLog; console.error = origErr; }
  return lines.join('\n');
}

// Position worth $0.30 cost, 5% margin target ($0.015). With sellQuoteMult 1.049
// the profit (~$0.0101) clears the 1.5x-gas bar (~$0.0069) but NOT the margin.
function holdingPosition(now, marginAtOpen = 5) {
  return {
    buyCostUsd: 0.3, buyGasUsd: 0.0001, amountWei: (10n ** 22n).toString(),
    comboKey: '30_70_5_70_cd20', marginAtOpen, sizeAtOpen: 70,
    buyTx: '0x', buyTs: now - 3600e3,
  };
}

function spikeMarket(kv, price, now) {
  kv.set('price:high1h', { sq: sqFor(price * 10).toString(), ts: now - 10 * 60e3 });
  kv.set('price:tick', { sq: sqFor(price / 1.15).toString(), ts: now - 60e3, prevMoveBps: 0 }); // +15% spike
  kv.set('price:buckets', Array.from({ length: 10 }, (_, k) => ({ ts: now - (10 - k) * 60e3, sq: sqFor(price).toString() })));
}

test('spike: below own target (above 1.5x bar) -> no exit', async () => {
  const price = 1e-8;
  const chain = new FakeChain({ priceWeth: price }).install();
  try {
    const kv = new MemKV();
    const now = Date.now();
    chain.tokens.set(W0.toLowerCase(), 10n ** 22n);
    chain.eth.set(W0.toLowerCase(), 10n ** 14n);
    kv.set('wallet:0:seed', { dip: 40, margin: 3, size: 70, cooldownMin: 10 });
    kv.set('wallet:0:qgridver', 10);
    kv.set('wallet:0:lastTrade', now - 3600e3);
    kv.set('wallet:0:position', holdingPosition(now, 5));
    spikeMarket(kv, price, now);
    chain.sellQuoteMult = 1.049; // ~$0.0101 profit: clears 1.5x gas, not the 5% margin
    const env = { TRADER_KV: kv, DRY_RUN: 'false', RPC_URLS: 'http://fake-rpc', ZORA_API_KEY: 'x', BURNER_KEY_0: generatePrivateKey() };

    const log = await tick(env);
    assert.match(log, /accelerated exit evaluation/, 'spike pass ran');
    assert.match(log, /SKIP sell \(spike\)/, 'spike exit blocked below own target');
    assert.equal(chain.sent.filter((s) => s.kind === '0x5e').length, 0, 'no sell broadcast');
    assert.ok(kv.json('wallet:0:position'), 'position still held');
  } finally { chain.uninstall(); }
});

test('spike: owner-driven -> whole pass holds', async () => {
  const price = 1e-8;
  const chain = new FakeChain({ priceWeth: price }).install();
  try {
    const kv = new MemKV();
    const now = Date.now();
    chain.tokens.set(W0.toLowerCase(), 10n ** 22n);
    chain.eth.set(W0.toLowerCase(), 10n ** 14n);
    kv.set('wallet:0:seed', { dip: 40, margin: 3, size: 70, cooldownMin: 10 });
    kv.set('wallet:0:qgridver', 10);
    kv.set('wallet:0:lastTrade', now - 3600e3);
    kv.set('wallet:0:position', holdingPosition(now, 5));
    spikeMarket(kv, price, now);
    chain.sellQuoteMult = 1.049;
    // Attribution: owner EOA bought 100 of 110 BRAWL in the window.
    const pid = __internal.poolId();
    // V4: amount0 is the TRADER's delta — a BUY of BRAWL (currency0) is POSITIVE.
    const buyWord = (b) => BigInt(Math.round(b * 1e18)).toString(16).padStart(64, '0');
    const mkLog = (buyBrawl, tx) => ({
      topics: [SWAP_TOPIC0, pid], data: '0x' + buyWord(buyBrawl) + '00'.repeat(160), transactionHash: tx,
    });
    chain.swapLogs = [mkLog(100, '0xaaa'), mkLog(10, '0xbbb')];
    chain.txByHash.set('0xaaa', { from: __internal.OWNER_EOA });
    chain.txByHash.set('0xbbb', { from: '0x0000000000000000000000000000000000001234' });
    const env = { TRADER_KV: kv, DRY_RUN: 'false', RPC_URLS: 'http://fake-rpc', ZORA_API_KEY: 'x', BURNER_KEY_0: generatePrivateKey() };

    const log = await tick(env);
    assert.match(log, /spike attribution: owner\/fleet bought 100\.0 of 110\.0/, 'attribution ran');
    assert.match(log, /SPIKE HOLD: dominant buy volume is owner\/fleet/, 'pass held');
    assert.equal(chain.sent.filter((s) => s.kind === '0x5e').length, 0, 'no sell broadcast');
    assert.ok(kv.json('wallet:0:position'), 'position still held');
  } finally { chain.uninstall(); }
});

test('spike: attribution fails open on RPC error', async () => {
  const logs = [];
  const r = await __internal.isOwnerDrivenSpike(
    { getBlockNumber: async () => 100n, getLogs: async () => { throw new Error('boom'); } },
    (m) => logs.push(m));
  assert.equal(r.ownerDriven, false, 'fails open');
  assert.match(logs.join('\n'), /fail open/);
});

test('spike: at most 4 spike exits per tick, rest via normal branch', async () => {
  const price = 1e-8;
  const chain = new FakeChain({ priceWeth: price }).install();
  try {
    const kv = new MemKV();
    const now = Date.now();
    const env = { TRADER_KV: kv, DRY_RUN: 'false', RPC_URLS: 'http://fake-rpc', ZORA_API_KEY: 'x' };
    for (let i = 0; i < 6; i++) {
      const w = BURNERS[i];
      chain.tokens.set(w.toLowerCase(), 10n ** 22n);
      chain.eth.set(w.toLowerCase(), 10n ** 14n);
      kv.set(`wallet:${i}:seed`, { dip: 40, margin: 3, size: 70, cooldownMin: 10 });
      kv.set(`wallet:${i}:qgridver`, 10);
      kv.set(`wallet:${i}:lastTrade`, now - 3600e3);
      kv.set(`wallet:${i}:position`, holdingPosition(now, 1)); // 1% margin: 1.3x quote clears it
      env[`BURNER_KEY_${i}`] = generatePrivateKey();
    }
    spikeMarket(kv, price, now);
    chain.sellQuoteMult = 1.3; // +30%: every wallet is past its own target

    const log = await tickFull(env);
    const spikeExits = (log.match(/spike exit executed/g) || []).length;
    assert.ok(spikeExits <= 4, `spike pass capped at 4 (saw ${spikeExits})`);
    assert.match(log, /evaluating top 4 this tick/, 'stagger logged');
    for (let i = 0; i < 6; i++) assert.equal(kv.json(`wallet:${i}:position`), null, `w${i} exited`);
    assert.equal(chain.sent.filter((s) => s.kind === '0x5e').length, 6, 'all six sold exactly once');
  } finally { chain.uninstall(); }
});

test('spike attribution: owner SELLING into the spike is not "owner-driven"; uses the latest buys', async () => {
  const pid = __internal.poolId();
  const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
  const mk = (amount0, tx) => ({ topics: [SWAP_TOPIC0, pid], data: '0x' + w(amount0) + '00'.repeat(160), transactionHash: tx });
  const from = { '0xs': __internal.OWNER_EOA, '0xb': '0x0000000000000000000000000000000000009999' };
  const client = (logs) => ({ getBlockNumber: async () => 1000n, getLogs: async () => logs,
    getTransaction: async ({ hash }) => ({ from: from[hash] ?? __internal.OWNER_EOA }) });
  // Owner dumps 100 BRAWL (negative = trader paid BRAWL in), an outsider buys 10.
  let r = await __internal.isOwnerDrivenSpike(client([mk(-100n * 10n ** 18n, '0xs'), mk(10n * 10n ** 18n, '0xb')]), () => {});
  assert.equal(r.ownerDriven, false, 'owner selling does not make the spike owner-driven');
  // 12 old owner buys followed by 12 newer outsider buys: only the latest 12 count.
  const old = Array.from({ length: 12 }, (_, k) => mk(10n ** 18n, `0xold${k}`));
  const recent = Array.from({ length: 12 }, (_, k) => { from[`0xnew${k}`] = '0x0000000000000000000000000000000000009999'; return mk(10n ** 18n, `0xnew${k}`); });
  r = await __internal.isOwnerDrivenSpike(client([...old, ...recent]), () => {});
  assert.equal(r.ownerDriven, false, 'recent outsider buys decide, not stale owner buys');
});
