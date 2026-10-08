// Runs the REAL worker in Cloudflare's runtime (workerd, via `wrangler dev`) against a
// local fake chain. Proves: DO binding works, alarm loop ticks on its own, health/pause
// endpoints work, nothing overlaps. Offline-safe (DRY_RUN, fake RPC). ~40 s.
//   npm run test:workerd
import { spawn } from 'node:child_process';
// Async child runner: spawnSync would block THIS process, which also serves the fake RPC
// the worker calls back into — a deadlock.
const run = (args, env) => new Promise((res) => { const c = spawn(process.execPath, args, { env }); let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; }); c.on('close', (status) => res({ status, stdout, stderr })); });
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FakeChain } from '../helpers/fake-chain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const chain = new FakeChain({ priceWeth: 1e-8 });
const rpc = createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
    const one = (r) => { try { return { jsonrpc: '2.0', id: r.id, result: chain.rpc(r.method, r.params) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: e.message } }; } };
    const j = JSON.parse(body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
  });
}).listen(0);
const rpcPort = rpc.address().port;
const PORT = 8790 + Math.floor(Math.random() * 100);
const wr = spawn(process.execPath, [resolve(HERE, '../../node_modules/wrangler/bin/wrangler.js'), 'dev', '-c', resolve(HERE, 'wrangler.test.toml'),
  '--port', String(PORT), '--var', `RPC_URLS:http://127.0.0.1:${rpcPort}`, '--log-level', 'warn'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; wr.stdout.on('data', (d) => { out += d; }); wr.stderr.on('data', (d) => { out += d; });
const base = `http://127.0.0.1:${PORT}`;
const get = (p, m = 'GET') => fetch(base + p, { method: m, headers: { 'x-tick-token': 'test-token' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('FAIL:', m, '\n--- wrangler output ---\n' + out.slice(-3000)); wr.kill(); rpc.close(); process.exit(1); };
try {
  for (let k = 0; ; k++) { try { if ((await fetch(base + '/status')).ok) break; } catch { } if (k > 60) fail('wrangler dev did not start'); await sleep(1000); }
  if ((await fetch(base + '/health')).status !== 403) fail('/health must require the token');
  await get('/ensure');                                     // what the cron does
  let h;
  for (let k = 0; k < 40; k++) { h = await (await get('/health')).json(); if ((h.heartbeat?.ticks || 0) >= 2) break; await sleep(1000); }
  if ((h.heartbeat?.ticks || 0) < 2) fail(`alarm loop did not tick twice: ${JSON.stringify(h.heartbeat)}`);
  if (!h.alarmAt) fail('alarm not re-armed');
  if (!h.logLines.some((l) => /=== tick start ===/.test(l))) fail('no tick log');
  // The operator tools, exactly as Wren runs them (one https call each, no RPC from "her PC").
  const opsEnv = { ...process.env, WORKER_URL: base, TICK_TOKEN: 'test-token' };
  const doc = await run([resolve(HERE, '../../local-runner/doctor.mjs'), '--remote', '--json'], opsEnv);
  let report; try { report = JSON.parse(doc.stdout); } catch { fail('doctor output: ' + doc.stdout + doc.stderr.slice(-1500)); }
  if (report.mode !== 'cloudflare' || !report.heartbeat) fail(`doctor --remote: ${doc.stdout}${doc.stderr}`);
  if (report.findings.some((f) => /Onchain check skipped/.test(f.what))) fail('server-side chain check failed: ' + JSON.stringify(report.findings));
  console.log(`doctor --remote: status=${report.status}; ${report.findings.map((f) => f.what).join(' | ')}`);
  const ops = (c) => run([resolve(HERE, '../../local-runner/ops.mjs'), c], opsEnv);
  if ((await ops('pause')).status !== 0) fail('ops pause');
  const before = (await (await get('/health')).json()).heartbeat.ticks;
  await sleep(12000);
  const after = (await (await get('/health')).json()).heartbeat.ticks;
  if (after !== before) fail(`ticked while paused (${before} -> ${after})`);
  const doc2 = JSON.parse((await run([resolve(HERE, '../../local-runner/doctor.mjs'), '--remote', '--json'], opsEnv)).stdout);
  if (!doc2.findings.some((f) => /PAUSED/.test(f.what))) fail('doctor did not report the pause');
  if ((await ops('resume')).status !== 0) fail('ops resume');
  console.log(`PASS workerd: ${after} alarm ticks in Cloudflare's runtime, health/pause/resume OK, last tick ${h.heartbeat.lastMs} ms`);
  console.log('last tick log:\n  ' + h.logLines.filter(Boolean).slice(-8).join('\n  '));
} catch (e) { fail(e.stack); }
wr.kill(); rpc.close(); process.exit(0);
