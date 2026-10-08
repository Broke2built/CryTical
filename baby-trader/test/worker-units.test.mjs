import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test as W } from '../worker.js';

test('closeReward: losses are not discounted by hold time, gains are', () => {
  assert.equal(W.closeReward(-0.3, 0.5), W.closeReward(-0.3, 10)); // holding a loser buys nothing
  assert.ok(W.closeReward(0.2, 0.5) > W.closeReward(0.2, 10));     // fast gains still preferred
  assert.equal(W.closeReward(-0.3, 10), -3000);
});

test('rollLow24: corrupt stored low (7e29%-style) is discarded', () => {
  const now = Date.now();
  const nowSq = 10n ** 30n;
  const r = W.rollLow24({ sq: '1000', ts: now - 60e3 }, nowSq, now, [{ ts: now - 5 * 60e3, sq: (nowSq * 9n / 10n).toString() }]);
  assert.equal(BigInt(r.sq), nowSq * 9n / 10n);
});

test('rollLow24: new low is timestamped now; expired low rebuilt from buckets', () => {
  const now = Date.now();
  const r1 = W.rollLow24({ sq: '200', ts: now - 3600e3 }, 150n, now, []);
  assert.deepEqual(r1, { sq: '150', ts: now });
  const r2 = W.rollLow24({ sq: '100', ts: now - W.LOW_WINDOW_MS - 1 }, 150n, now, [{ ts: now - 3600e3, sq: '120' }]);
  assert.deepEqual(r2, { sq: '120', ts: now - 3600e3 });
});

test('bottomSignal: never fires AT a fresh low, fires on a held, bounced low', () => {
  assert.equal(W.bottomSignal(0, 0), false);            // the old falling-knife case
  assert.equal(W.bottomSignal(5, 5 * 60e3), false);     // low only 5 min old
  assert.equal(W.bottomSignal(5, 45 * 60e3), true);     // held 45 min, 5% off it
  assert.equal(W.bottomSignal(15, 45 * 60e3), false);   // too far off the low
});

test('buildFeatures: returns are price returns (sq is linear in price)', () => {
  const now = Date.now();
  const base = 10n ** 30n;
  const buckets = [{ ts: now - 6 * 60e3, sq: base }, { ts: now, sq: base * 110n / 100n }];
  const F = W.buildFeatures({ buckets, nowSq: base * 110n / 100n, highSq: base * 110n / 100n, low24Sq: base,
    prevSq: base, moveBps: 1000, ethBal: 0n, brawlBal: 0n, stats: {}, gasPriceWei: 0n, ethUsd: 3000, now });
  assert.equal(F.length, W.NN_IN);
  assert.ok(Math.abs(F[0] - Math.tanh(10 * Math.log(1.1))) < 1e-9, `F[0]=${F[0]}`);
});

test('selectCombo never returns the baseline key', () => {
  const q = W.blankQTable();
  q.baseline_unattributed = 1e9;
  const rng = { s: 1 };
  for (let k = 0; k < 200; k++) assert.notEqual(W.selectCombo(q, rng, () => {}, 0.5), 'baseline_unattributed');
});
