// scenarios.mjs — the "behavior recording" (golden master) for worker.js.
//
// WHY THIS EXISTS (read before refactoring anything):
// worker.js moves real money. A refactor that "only moves code around" can still change
// what the bot does (a reordered await, a renamed key, a changed default). This file
// runs worker.js through a fixed script of market situations on a fake chain with a
// FROZEN clock and FIXED keys, and records EVERYTHING observable:
//   - every transaction sent (who, what kind, the exact calldata),
//   - the full KV state after every tick,
//   - every log line (timestamps normalized).
// test/golden.test.mjs replays it and requires a byte-for-byte match with
// test/golden/recording.json. If you change behavior ON PURPOSE, re-record:
//   node test/golden/record.mjs      (then read the diff in git before committing!)
import worker, { BURNERS, __internal } from '../../worker.js';
import { FakeChain, MemKV, sqFor } from '../helpers/fake-chain.mjs';

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0); // fixed start time
const KEYS = Array.from({ length: 16 }, (_, i) => '0x' + (BigInt(i + 1) * 0x1111111111111111111111111111111111111111111111111111111111111n).toString(16).padStart(64, '0'));

function freezeClock() {
  const RealDate = globalThis.Date;
  let now = T0;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(now); else super(...a); }
    static now() { return now; }
  }
  globalThis.Date = FakeDate;
  return { advance: (ms) => { now += ms; }, now: () => now, restore: () => { globalThis.Date = RealDate; } };
}

const normLog = (s) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<T>');

export async function runScenarios() {
  const clock = freezeClock();
  const chain = new FakeChain({ priceWeth: 1e-8 }).install();
  const origLog = console.log;
  const out = [];
  try {
    const kv = new MemKV();
    const env = { TRADER_KV: kv, DRY_RUN: 'false', RPC_URLS: 'http://fake-rpc', ZORA_API_KEY: 'x' };
    KEYS.forEach((k, i) => { env[`BURNER_KEY_${i}`] = k; });
    const tick = async (label, setup) => {
      if (setup) await setup();
      kv.set('meta:tickLock', 0);
      const sent0 = chain.sent.length;
      const lines = [];
      console.log = (...a) => lines.push(normLog(a.join(' ')));
      try { await worker.scheduled({}, env, {}); } finally { console.log = origLog; }
      const state = Object.fromEntries([...kv.m.entries()].filter(([k]) => k !== 'meta:lastTickLog').sort(([a], [b]) => (a < b ? -1 : 1)));
      out.push({ label, sent: chain.sent.slice(sent0).map((s) => ({ kind: s.kind, who: s.who, hash: s.hash })), logs: lines, state });
      clock.advance(60e3);
    };
    const P = 1e-8;
    const at = (mult) => sqFor(P * mult).toString();
    // Fund 8 wallets (the rest stay empty — "cannot buy" paths).
    for (let i = 0; i < 8; i++) chain.eth.set(BURNERS[i].toLowerCase(), 10n ** 15n);

    await tick('1 first tick, no history');
    await tick('2 quiet tick');
    await tick('3 value dip 90% below 1h high -> buys', () => {
      kv.set('price:high1h', { sq: at(10), ts: clock.now() - 10 * 60e3 });
    });
    await tick('4 holding, no exit', () => { chain.sellQuoteMult = 1.0; });
    await tick('5 spike +15%, outsider-driven, targets met -> staggered spike exits', () => {
      kv.set('price:tick', { sq: at(1 / 1.15), ts: clock.now() - 60e3, prevMoveBps: 0 });
      chain.sellQuoteMult = 1.3;
    });
    await tick('6 remaining exits via holding branch', () => { chain.sellQuoteMult = 1.3; });
    await tick('7 re-entry after cooldown', () => {
      for (let i = 0; i < 16; i++) kv.set(`wallet:${i}:lastTrade`, clock.now() - 3600e3);
      kv.set('price:high1h', { sq: at(10), ts: clock.now() - 10 * 60e3 });
      chain.sellQuoteMult = 1.0;
    });
    await tick('8 crash -60%: hard stop', () => { chain.sellQuoteMult = 0.4; });
    await tick('9 orphan with write-ahead record (position lost after buy)', () => {
      chain.tokens.set(BURNERS[10].toLowerCase(), 10n ** 22n);
      kv.set('wallet:10:pendingBuy', { comboKey: '30_70_3_70_cd6', sizePct: 70, ts: clock.now() - 120e3 });
      chain.sellQuoteMult = 1.0;
    });
    await tick('10 ghost position (KV says holding, chain empty)', () => {
      kv.set('wallet:11:position', { buyCostUsd: 0.2, buyGasUsd: 0.0001, amountWei: '1000', comboKey: '30_70_3_70_cd6', marginAtOpen: 3, sizeAtOpen: 70, buyTx: '0x', buyTs: clock.now() - 3600e3, ethBalPostBuy: '0' });
    });
    await tick('11 circuit breaker (+25% in one tick)', () => {
      kv.set('price:tick', { sq: at(1 / 1.25), ts: clock.now() - 60e3, prevMoveBps: 0 });
    });
    await tick('12 owner-driven spike holds', () => {
      kv.set('circuit:tripped', null);
      kv.set('price:tick', { sq: at(1 / 1.15), ts: clock.now() - 60e3, prevMoveBps: 0 });
      // Owner EOA bought 100 BRAWL (V4: positive amount0 = trader received BRAWL).
      const word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
      chain.swapLogs = [{ topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', __internal.poolId()],
        data: '0x' + word(100n * 10n ** 18n) + '00'.repeat(160), transactionHash: '0xa' }];
      chain.txByHash.set('0xa', { from: __internal.OWNER_EOA });
      chain.sellQuoteMult = 1.3;
      kv.set('price:high1h', { sq: at(1), ts: clock.now() - 10 * 60e3 }); // no dip -> no buy signals
      for (let i = 0; i < 16; i++) kv.set(`wallet:${i}:lastTrade`, clock.now() - 3600e3);
    });
  } finally {
    console.log = origLog;
    chain.uninstall();
    clock.restore();
  }
  return out;
}
