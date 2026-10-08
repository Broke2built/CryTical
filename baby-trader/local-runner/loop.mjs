// loop.mjs — run the fleet 24/7 on a local PC. Replaces the Cloudflare cron.
//
// ============================== NOTES FOR WREN ==============================
// One long-lived scheduler process that starts `run-tick.mjs` once per minute,
// ALWAYS waiting for the previous tick to exit first. Ticks can never overlap
// (run-tick.mjs also holds an OS lock file, so even a stray manual run can't
// double-trade). Each tick is its own child process, so a wedged tick can't poison
// the next one and memory never creeps.
//
// Why not cron? Cron fires every minute whether or not the last tick finished; on a
// degraded network a tick can take minutes. With the lock, cron would just skip —
// fine — but this loop also gives you: a heartbeat file, monitor-compatible log lines
// (`<ISO>Z tick exit=<code>`, what baby-monitor.mjs parses), log rotation, and a
// hang watchdog.
//
// WATCHDOG: a tick is only killed after TICK_HARD_KILL_MS (default 15 min). That is far
// beyond every internal bound in worker.js (45s/wallet deadline, 120s/batch, 90s receipt
// wait), so a kill means something is truly wedged. The kill is logged as
// `tick exit=137 KILLED` — run baby-monitor and check for orphans after one.
//
// Run it under something that restarts it (pm2, systemd, Task Scheduler "at logon"):
//   KEYS_FILE=... KV_FILE=... RPC_URLS=... DRY_RUN=true TICK_FLOCK=/tmp/slippy-local-tick.lock \
//     pm2 start local-runner/loop.mjs --name babies
// IMPORTANT: if you still have the old per-minute cron line for run-tick, REMOVE it.
// (Both would be safe thanks to the lock — but you'd get double log lines and skips.)
// Stop it with Ctrl+C / SIGTERM: it lets the in-flight tick finish, then exits.
// ===========================================================================

import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, statSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INTERVAL_MS = +(process.env.TICK_INTERVAL_MS || 60000);
const HARD_KILL_MS = +(process.env.TICK_HARD_KILL_MS || 15 * 60000);
const LOG = resolve(process.env.TICK_LOG || resolve(HERE, 'tick.log'));
const HEARTBEAT = resolve(process.env.HEARTBEAT_FILE || resolve(HERE, 'heartbeat.json'));
const MAX_LOG_BYTES = +(process.env.TICK_LOG_MAX_BYTES || 50 * 1024 * 1024);
const MAX_TICKS = +(process.env.MAX_TICKS || 0); // 0 = forever (tests set this)
// The command is overridable for tests; production runs run-tick.mjs.
const BASE_CMD = process.env.LOOP_TICK_CMD ? JSON.parse(process.env.LOOP_TICK_CMD) : [process.execPath, resolve(HERE, 'run-tick.mjs')];
// TICK_FLOCK=/tmp/slippy-local-tick.lock wraps every tick in `flock <file>` (Linux/macOS),
// the lock your hourly KV backup, MERGE-PLAN surgery and baby-monitor already use — so
// those tools keep excluding ticks exactly as they did under the old cron line.
const CMD = process.env.TICK_FLOCK ? ['flock', process.env.TICK_FLOCK, ...BASE_CMD] : BASE_CMD;

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log(`loop: ${sig} — finishing current tick, then exiting`); });

const isoS = () => new Date().toISOString().slice(0, 19) + 'Z'; // baby-monitor regex has no millis
function log(line) {
  try {
    if (existsSync(LOG) && statSync(LOG).size > MAX_LOG_BYTES) renameSync(LOG, LOG + '.1'); // keep one old file
    appendFileSync(LOG, line.endsWith('\n') ? line : line + '\n');
  } catch (e) { console.error(`log write failed: ${e.message}`); }
}

function runTick() {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(CMD[0], CMD.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let killed = false;
    const watchdog = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, HARD_KILL_MS);
    child.on('close', (code, signal) => {
      clearTimeout(watchdog);
      const exit = code ?? (signal === 'SIGKILL' ? 137 : 1);
      if (out) log(out.trimEnd());
      log(`${isoS()} tick exit=${exit}${killed ? ' KILLED (hung > ' + Math.round(HARD_KILL_MS / 60000) + 'm — check orphans)' : ''} ms=${Date.now() - t0}`);
      done({ exit, ms: Date.now() - t0 });
    });
  });
}

let n = 0, consecutiveFails = 0;
log(`${isoS()} loop: start (interval ${INTERVAL_MS}ms, hard-kill ${HARD_KILL_MS}ms, cmd ${CMD.slice(1).join(' ')})`);
while (!stopping && (!MAX_TICKS || n < MAX_TICKS)) {
  const started = Date.now();
  const { exit, ms } = await runTick();
  n++;
  consecutiveFails = exit === 0 ? 0 : consecutiveFails + 1;
  try {
    writeFileSync(HEARTBEAT, JSON.stringify({ ts: Date.now(), iso: new Date().toISOString(), ticks: n, lastExit: exit, lastMs: ms, consecutiveFails, pid: process.pid }));
  } catch { /* heartbeat is advisory */ }
  if (stopping || (MAX_TICKS && n >= MAX_TICKS)) break;
  // Align to the interval; never start early, never stack.
  const wait = Math.max(1000, INTERVAL_MS - (Date.now() - started));
  await new Promise((r) => setTimeout(r, wait));
}
log(`${isoS()} loop: stopped after ${n} ticks`);
