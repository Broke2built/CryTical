// train.mjs — massively parallel training: island tournaments on every CPU core,
// on procedurally generated markets learned from real Base order flow, then an honest
// out-of-sample exam on pools the babies never trained on.
//
// ============================== NOTES FOR WREN ==============================
// ISLANDS: each CPU core runs its own 16-baby tournament (its own "island"). After every
// epoch, the best brains migrate to the next island and replace its worst. Islands
// keep diversity (a single tournament collapses into one family within ~50 generations
// — every top baby ends up descended from the same ancestor). Migration spreads what
// works without the monoculture.
//
// MARKETS: scenario 'real' — outsider flow generated from real Base swap patterns
// (sim/synth.mjs), a different jittered real pool every generation. 1 generation = 1
// simulated day (1440 one-minute ticks) for 16 babies.
//
// THE EXAM (read the numbers, not the vibes):
//   trained-on-holdout  vs  untrained-on-holdout, both with exploration OFF, on pools
//   NEVER used in training. Only a gap here means the babies learned something that
//   transfers. If trained wins on train pools but not on holdout, it memorized.
//
// SPEED: no network, no RPC, no APIs — pure math on typed arrays. Throughput is printed
// as baby-years per hour. Scale with --islands (defaults to all cores) and --epochs.
// ===========================================================================
//
// Usage: node sim/train.mjs [--epochs 20] [--gens 50] [--islands N] [--grid live|tight]
//                            [--one-per-tick] [--strategy dip|momentum|both] [--bankroll 0.0001] [--out sim/trained-brains.json]

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (!isMainThread) {
  const { runTournament } = await import('./tournament.mjs');
  parentPort.on('message', (job) => {
    const res = runTournament({ ...job, lean: true });
    const last = res.history.at(-1);
    parentPort.postMessage({
      ranking: last.leaderboard.map((b) => b.id),
      brains: Object.values(res.brains),
      days: res.history.map((h) => h.fleet.netPnl),
      trades: res.history.reduce((a, h) => a + h.fleet.trades, 0),
    });
  });
} else {
  const { loadProfiles, splitProfiles } = await import('./synth.mjs');
  const { runTournament } = await import('./tournament.mjs');
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const EPOCHS = +arg('--epochs', 20), GENS = +arg('--gens', 50);
  const ISLANDS = +arg('--islands', availableParallelism());
  const GRID = arg('--grid', 'live'), ONE = args.includes('--one-per-tick'), STRAT = arg('--strategy', 'dip');
  const BANKROLL = +arg('--bankroll', 0.0001); // ETH per baby (~$0.30 live)
  const ETH_USD = 3000, MIGRANTS = 4;

  const { train, holdout } = splitProfiles(loadProfiles());
  if (!train.length || !holdout.length) { console.error('need real data: node sim/fetch-real.mjs'); process.exit(2); }
  console.log(`bankroll ${BANKROLL} ETH/baby, strategy ${STRAT}, grid ${GRID}${ONE ? ', one-per-tick' : ''} | real-flow profiles: ${train.length} train / ${holdout.length} holdout | ${ISLANDS} islands x ${EPOCHS} epochs x ${GENS} days`);

  const workers = Array.from({ length: ISLANDS }, () => new Worker(fileURLToPath(import.meta.url)));
  const run = (w, job) => new Promise((res) => { w.once('message', res); w.postMessage(job); });
  let pops = Array.from({ length: ISLANDS }, () => null);
  const t0 = Date.now();
  let babyDays = 0;
  for (let e = 0; e < EPOCHS; e++) {
    const results = await Promise.all(workers.map((w, k) => run(w, {
      scenario: 'real', profiles: train, generations: GENS, ticks: 1440, seed: 1000 * e + k + 1,
      grid: GRID, onePerTick: ONE, strategy: STRAT, bankrollEth: BANKROLL, initialBrains: pops[k],
    })));
    babyDays += ISLANDS * GENS * 16;
    // Migration: island k's best MIGRANTS replace island k+1's worst MIGRANTS.
    pops = results.map((r) => r.ranking.map((id) => r.brains[id])); // best -> worst
    const next = pops.map((p) => p.slice());
    for (let k = 0; k < ISLANDS; k++) {
      const dst = (k + 1) % ISLANDS;
      for (let m = 0; m < MIGRANTS; m++) next[dst][15 - m] = { ...pops[k][m], lineage: `i${k}:${pops[k][m].lineage.slice(0, 40)}` };
    }
    pops = next;
    const allDays = results.flatMap((r) => r.days).sort((a, b) => a - b);
    const med = allDays[Math.floor(allDays.length / 2)] * ETH_USD;
    const hrs = (Date.now() - t0) / 3600e3;
    console.log(`epoch ${String(e + 1).padStart(3)}: median fleet $/day ${med.toFixed(3)} | ${(babyDays / 365).toFixed(0)} baby-years simulated | ${((babyDays / 365) / hrs).toFixed(0)} baby-years/hour`);
  }
  await Promise.all(workers.map((w) => w.terminate()));

  // ---- the exam: holdout pools, exploration off, no evolution ----
  const exam = (brains, seed) => {
    const res = runTournament({ scenario: 'real', profiles: holdout, generations: 300, ticks: 1440, seed,
      grid: GRID, onePerTick: ONE, strategy: STRAT, bankrollEth: BANKROLL, initialBrains: brains, epsilon: 0, cull: 0, mutation: 0, lean: true });
    const d = res.history.map((h) => h.fleet.netPnl * ETH_USD).sort((a, b) => a - b);
    return { median: d[Math.floor(d.length / 2)], mean: d.reduce((a, b) => a + b, 0) / d.length, trades: res.history.reduce((a, h) => a + h.fleet.trades, 0) / d.length };
  };
  const trained = pops[0];
  const a = exam(trained, 777), b = exam(null, 777);
  const c = runTournament({ scenario: 'real', profiles: train, generations: 300, ticks: 1440, seed: 777, grid: GRID, onePerTick: ONE, strategy: STRAT, bankrollEth: BANKROLL,
    initialBrains: trained, epsilon: 0, cull: 0, mutation: 0, lean: true }).history.map((h) => h.fleet.netPnl * ETH_USD);
  const cMed = c.sort((x, y) => x - y)[Math.floor(c.length / 2)];
  console.log(`\n=== EXAM (300 days each, exploration off) ===`);
  console.log(`trained   on TRAIN pools   : median fleet $/day ${cMed.toFixed(3)}`);
  console.log(`trained   on HOLDOUT pools : median ${a.median.toFixed(3)}  mean ${a.mean.toFixed(3)}  closes/day ${a.trades.toFixed(1)}`);
  console.log(`untrained on HOLDOUT pools : median ${b.median.toFixed(3)}  mean ${b.mean.toFixed(3)}  closes/day ${b.trades.toFixed(1)}`);
  // Verdict needs a REAL margin and real profit, not noise: trained must make money on
  // unseen pools AND beat untrained by >= 20% of untrained's absolute daily P&L.
  const margin = a.median - b.median, noise = Math.max(0.02, 0.2 * Math.abs(b.median));
  console.log(a.median > 0 && margin > noise
    ? `EDGE: trained makes $${a.median.toFixed(3)}/day on unseen pools (+$${margin.toFixed(3)} vs untrained).`
    : `NO EDGE out-of-sample (trained ${a.median.toFixed(3)} vs untrained ${b.median.toFixed(3)} $/day). Do not ship these brains.`);
  const out = arg('--out', new URL('./trained-brains.json', import.meta.url).pathname);
  writeFileSync(out, JSON.stringify({ grid: GRID, onePerTick: ONE, exam: { trainedHoldout: a, untrainedHoldout: b, trainedTrainMedian: cMed },
    brains: Object.fromEntries(trained.map((br, i) => [`baby_${i}`, br])) }));
  console.log(`brains -> ${out} (SIM-ONLY; merge per MERGE-PLAN.md, never overwrite live)`);
}
