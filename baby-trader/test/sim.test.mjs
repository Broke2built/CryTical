import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runTournament, Pool } from '../sim/tournament.mjs';
import { __test as W } from '../worker.js';

test('pool: buying moves price up for the next trader, fees are kept', () => {
  const p = new Pool(0.1, 1e7, 0.01);
  const p0 = p.price();
  p.buy(0.001);
  assert.ok(p.price() > p0);
  const coin = new Pool(0.1, 1e7, 0.01).buy(0.001);
  const back = new Pool(0.1, 1e7, 0.01);
  back.buy(0.001);
  assert.ok(back.sell(coin) < 0.001, 'round trip loses fees');
});

test('tournament: dead coin = no outsiders = fleet cannot make money', () => {
  const res = runTournament({ scenario: 'dead', generations: 2, ticks: 120, seed: 3 });
  for (const h of res.history) {
    assert.ok(h.fleet.netPnl <= 1e-12, `fleet pnl ${h.fleet.netPnl}`);
    assert.equal(h.external.trades, 0);
  }
});

test('tournament: survival of the fittest copies winners over losers', () => {
  const res = runTournament({ scenario: 'noise', generations: 3, ticks: 300, seed: 5 });
  assert.equal(res.history.length, 3);
  const lineages = Object.values(res.brains).map((b) => b.lineage);
  assert.ok(lineages.some((l) => l.includes('>g')), 'some babies descend from earlier winners');
  for (const b of Object.values(res.brains)) assert.equal(Object.keys(b.qtable).length, Object.keys(W.blankQTable()).length);
});

test('replay sim runs on synthetic data and reports unique entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-'));
  let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const series = (n, p0) => { let p = p0; return Array.from({ length: n }, (_, k) => { p *= Math.exp((r() - 0.5) * 0.2); return { t: 1.7e12 + k * 60e3, p }; }); };
  writeFileSync(join(dir, 'replay-data.json'), JSON.stringify({ coins: { SLIPPY: { points: series(400, 1e-8) }, BRAWL: { points: series(200, 1e-9) } } }));
  const kv = {};
  for (let i = 0; i < 16; i++) kv[`wallet:${i}:qtable`] = JSON.stringify(W.blankQTable());
  writeFileSync(join(dir, 'kv.json'), JSON.stringify(kv));
  const out = execFileSync(process.execPath, ['sim/sim.mjs'], { env: { ...process.env, SIM_DIR: dir, SIM_KV: join(dir, 'kv.json'), SIM_EPISODES: '20' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const agg = JSON.parse(readFileSync(join(dir, 'sim-agg.json'), 'utf8'));
  assert.equal(agg.episodes, 20);
  for (const ra of Object.values(agg.roleAgg)) for (const st of Object.values(ra.signalStats)) assert.ok(st.uniqueEntries <= st.trades);
  void out;
});

test('synth: fitted profile reproduces persistence and impacts sized to the target move', async () => {
  const { fitProfile, makeFlow, sizeForImpact } = await import('../sim/synth.mjs');
  // 300 swaps, 1 per 10 blocks, strongly persistent direction, impact 0.01
  let dir = 1; const ev = [];
  for (let k = 0; k < 300; k++) { if (k % 8 === 0) dir = -dir; ev.push([k * 10, dir * 0.01]); }
  const p = fitProfile('x', ev);
  assert.ok(p.persist > 0.8 && p.persist < 0.95, `persist ${p.persist}`);
  let s = 3; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const f = makeFlow(p, r);
  let same = 0, n = 0, last = 0;
  for (let t = 0; t < 3000; t++) for (const imp of f.step()) { if (last) { n++; if (Math.sign(imp) === Math.sign(last)) same++; } last = imp; }
  assert.ok(Math.abs(same / n - p.persist) < 0.05, `generated persistence ${same / n} vs fitted ${p.persist}`);
  const pool = new Pool(0.1, 1e7, 0.01), p0 = pool.price();
  const { side, amount } = sizeForImpact(pool, 0.05);
  assert.equal(side, 'buy');
  pool.buy(amount);
  assert.ok(Math.abs(Math.log(pool.price() / p0) - 0.05) < 1e-6);
});
