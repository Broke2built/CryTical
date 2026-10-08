import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WETH, coinIsToken0, coinPriceSq, decodeSwap, buildCoinEntry, SWAP_TOPIC0 } from '../local-runner/market-watcher.mjs';
import { computeAssignment, MAX_BABIES_PER_COIN } from '../local-runner/assignment.mjs';
import { evaluateSignals } from '../local-runner/fleet-dryrun.mjs';

const LOW = '0x1378d6A633E64f4abc22c07541473e3551E39b3F';  // sorts below WETH -> currency0
const HIGH = '0x9999999999999999999999999999999999999999'; // sorts above WETH -> currency1
const Q192 = 2n ** 192n;
const word = (v) => (BigInt.asUintN(256, BigInt(v))).toString(16).padStart(64, '0');

test('price orientation: coin above WETH is inverted back to WETH-per-coin', () => {
  assert.equal(coinIsToken0(LOW), true);
  assert.equal(coinIsToken0(HIGH), false);
  // Pool price (currency1/currency0) = 1e8 coin per WETH  ->  coin price = 1e-8 WETH.
  const sqrtP = BigInt(Math.round(Math.sqrt(1e8) * 2 ** 48)) * 2n ** 48n;
  const p = Number(coinPriceSq(sqrtP, HIGH)) / Number(Q192);
  assert.ok(Math.abs(p / 1e-8 - 1) < 1e-6, `got ${p}`);
  const p0 = Number(coinPriceSq(sqrtP, LOW)) / Number(Q192);
  assert.ok(Math.abs(p0 / 1e8 - 1) < 1e-6);
});

test('decodeSwap uses the COIN side of the pool, whichever currency it is', () => {
  // coin is currency1: pool pays out 5e18 coin (amount1 = -5e18), takes 0.01 WETH (amount0 = +1e16)
  const log = { data: '0x' + word(10n ** 16n) + word(-(5n * 10n ** 18n)) + word(0).repeat(4), topics: [SWAP_TOPIC0] };
  const s = decodeSwap(log, HIGH);
  assert.equal(s.traderBought, true);
  assert.equal(s.coinUnits, 5);
  assert.equal(s.weth, 0.01);
});

test('buildCoinEntry splits external vs fleet flow and keeps 24h of buckets', () => {
  const now = Date.now();
  const fleet = new Set(['0xaaaa']);
  const prev = { priceSq: (10n ** 30n).toString(), historyTicks: 20,
    buckets: Array.from({ length: 1500 }, (_, k) => ({ ts: now - (1500 - k) * 60e3, sq: (10n ** 30n).toString() })) };
  const e = buildCoinEntry({ coin: LOW, pid: '0x1', sq: 10n ** 30n, prev, now, curBlock: 100n, fleet, swaps: [
    { traderBought: true, coinUnits: 1, weth: 0.001, from: '0xAAAA', block: 99n },
    { traderBought: true, coinUnits: 1, weth: 0.002, from: '0xbbbb', block: 99n },
    { traderBought: false, coinUnits: 1, weth: 0.001, from: '0xcccc', block: 98n },
  ] });
  assert.equal(e.buckets.length, 1440);
  assert.equal(e.tape.fleetSwaps, 1);
  assert.equal(e.tape.externalSwaps, 2);
  assert.equal(e.tape.externalBuyers, 1);
  assert.equal(e.tape.externalBuyWeth, 0.002);
});

test('assignment: dead/fleet-only coins get no babies; live coins capped per coin', () => {
  const mk = (ext) => ({ valid: true, historyReady: true, externalSwaps1h: ext, moveBps: 100,
    tape: { externalBuyWeth: 0.01, externalSellWeth: 0.01, externalTraders: 5 } });
  const coins = ['0x01', '0x02', '0x03', '0x04', '0x05'].map((a) => ({ address: a, name: a }));
  const snap = { coins: { '0x01': mk(30), '0x02': mk(20), '0x03': mk(10), '0x04': mk(5), '0x05': mk(0) } };
  const { assignments, coinBabies } = computeAssignment(snap, { coins });
  assert.equal(coinBabies['0x05'], undefined, 'dead coin gets no babies');
  for (const babies of Object.values(coinBabies)) assert.ok(babies.length <= MAX_BABIES_PER_COIN);
  const sets = new Set(Object.values(assignments).map((a) => a.join()));
  assert.ok(sets.size > 2, 'babies hold different coin sets');
});

test('fresh coin: launch pullback needs external buyers; dead coin never signals', () => {
  const now = Date.now();
  const base = { priceSq: '80', launchHighSq: '108', high1hSq: '108', low24hSq: '80', moveBps: 0,
    firstSeenTs: now - 3600e3, externalSwaps1h: 10, buckets: [] };
  assert.equal(evaluateSignals({ ...base, tape: { externalBuyers: 0 } }, now).signals.length, 0);
  const s = evaluateSignals({ ...base, tape: { externalBuyers: 4 } }, now).signals;
  assert.deepEqual(s.map((x) => x.type), ['LAUNCH-PULLBACK']);
  assert.equal(evaluateSignals({ ...base, dead: true, tape: { externalBuyers: 4 } }, now).signals.length, 0);
  assert.equal(evaluateSignals({ ...base, externalSwaps1h: 0, tape: { externalBuyers: 4 } }, now).signals.length, 0);
});

test('WETH constant sanity', () => assert.equal(WETH.toLowerCase(), '0x4200000000000000000000000000000000000006'));
