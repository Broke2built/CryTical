// ops.mjs — one-word controls for the Cloudflare bot. Each is ONE https call to your
// worker (no RPC from this PC). Needs WORKER_URL and TICK_TOKEN env vars.
//
//   npm run ops -- pause      stop trading now (kill switch). Positions stay as they are.
//   npm run ops -- resume     start trading again
//   npm run ops -- ensure     restart the tick loop if it died
//   npm run ops -- tick       run one tick right now and print its log
//   npm run ops -- log        print the last tick's log
//   npm run ops -- backup     save the full bot state to backup-<time>.json in this folder
//   npm run ops -- restore <file>   upload a saved state (or a local kv-store.json) to the worker
import { writeFileSync, readFileSync } from 'node:fs';
const url = (process.env.WORKER_URL || '').replace(/\/$/, '');
const token = process.env.TICK_TOKEN;
const [cmd, arg] = process.argv.slice(2);
const routes = { pause: ['/pause', 'POST'], resume: ['/resume', 'POST'], ensure: ['/ensure', 'POST'], tick: ['/tick', 'POST'], log: ['/log', 'GET'], backup: ['/export', 'GET'], restore: ['/import', 'POST'] };
if (!routes[cmd]) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n')); process.exit(cmd ? 2 : 0); }
if (!url || !token) { console.error('Set WORKER_URL (https://<your-worker>.workers.dev) and TICK_TOKEN first.'); process.exit(2); }
const [path, method] = routes[cmd];
const body = cmd === 'restore' ? readFileSync(arg, 'utf8') : undefined;
const r = await fetch(url + path, { method, headers: { 'x-tick-token': token, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(120000) });
const text = await r.text();
if (r.status === 403) { console.error('Refused (403): TICK_TOKEN does not match the worker secret.'); process.exit(2); }
if (cmd === 'backup') { const f = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; writeFileSync(f, text); console.log(`saved ${f} (${(text.length / 1024).toFixed(0)} KB)`); }
else console.log(text);
process.exit(r.ok ? 0 : 1);
