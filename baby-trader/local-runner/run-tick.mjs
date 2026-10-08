// run-tick.mjs — run one SLIPPY trader tick locally (no Cloudflare).
//
// Usage:
//   KEYS_FILE=/path/to/keys.json DRY_RUN=true node run-tick.mjs
//   KEYS_FILE=/path/to/keys.json KV_FILE=/path/to/kv-store.json node run-tick.mjs
//
// Env vars:
//   KEYS_FILE   REQUIRED. JSON: {"BURNER_KEY_0":"0x...","...":"0x...","ZORA_API_KEY":"..."}.
//               chmod 600. Values are NEVER logged. No default.
//   DRY_RUN     "true" to skip all broadcasts (default "false").
//   KV_FILE     local KV store path (default ./kv-store.json).
//   RPC_URLS    comma-separated RPC list (default matches cf-meta.json).
//
// Imports ../worker.js, builds a fake `env`, and invokes the worker's
// scheduled() handler — the same entry point Cloudflare cron used.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LocalKV } from './kv-local.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- EGRESS GATE (2026-10-08): fail fast on wedged proxy ---
// The hatch-egress-proxy wedges regularly (port 3128 open, HTTPS CONNECTs hang).
// Without this gate, the tick hangs for 300s on dead RPC calls, blocking all
// trading. With it, we skip in <1s and the next tick retries.
try {
  const egressState = JSON.parse(readFileSync('/home/hatch/workspace/tools/egress-state.json', 'utf8'));
  const ageMs = Date.now() - new Date(egressState.checked_at).getTime();
  if (egressState.verdict === 'wedged' && ageMs < 10 * 60 * 1000) {
    console.log(`[${new Date().toISOString()}] tick skipped: egress wedged (state age ${Math.round(ageMs/1000)}s) — fail fast, retry next tick`);
    process.exit(0);
  }
  if (egressState.verdict === 'down' && ageMs < 10 * 60 * 1000) {
    console.log(`[${new Date().toISOString()}] tick skipped: egress down (state age ${Math.round(ageMs/1000)}s) — fail fast, retry next tick`);
    process.exit(0);
  }
} catch (e) {
  // No state file or unreadable — proceed (the tick's own RPC timeouts will handle it)
  console.log(`[${new Date().toISOString()}] egress gate: no state file (${e.message}) — proceeding`);
}

// --- secrets (never logged) ---
const KEYS_FILE = process.env.KEYS_FILE;
if (!KEYS_FILE) {
  console.error('FATAL: KEYS_FILE env var is required (JSON with BURNER_KEY_0..15 and ZORA_API_KEY)');
  process.exit(2);
}
if (!existsSync(KEYS_FILE)) {
  console.error(`FATAL: KEYS_FILE not found: ${KEYS_FILE}`);
  process.exit(2);
}
let keys;
try {
  keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
} catch (e) {
  console.error(`FATAL: KEYS_FILE is not valid JSON: ${e.message}`);
  process.exit(2);
}

// --- local KV ---
const KV_FILE = process.env.KV_FILE || resolve(HERE, 'kv-store.json');
const kv = new LocalKV(KV_FILE);

// --- fake worker env ---
const env = {
  TRADER_KV: kv,
  DRY_RUN: process.env.DRY_RUN === 'true' ? 'true' : 'false',
  RPC_URLS: process.env.RPC_URLS ||
    'https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org',
  ZORA_API_KEY: keys.ZORA_API_KEY || '',
};
let burnerCount = 0;
for (let i = 0; i < 16; i++) {
  const k = keys[`BURNER_KEY_${i}`];
  if (typeof k === 'string' && k.length > 0) {
    env[`BURNER_KEY_${i}`] = k;
    burnerCount++;
  }
}
if (burnerCount === 0) {
  console.error('FATAL: KEYS_FILE contains no BURNER_KEY_0..15 entries');
  process.exit(2);
}

// --- run one tick ---
const workerPath = resolve(HERE, '..', 'worker.js');
const mod = await import(workerPath);
if (!mod.default || typeof mod.default.scheduled !== 'function') {
  console.error('FATAL: worker.js does not export default.scheduled');
  process.exit(2);
}

try {
  await mod.default.scheduled({}, env, {});
} catch (e) {
  console.error(`FATAL: tick threw: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
}

// The scheduled handler persists its log lines to meta:lastTickLog — print them.
const logText = await kv.get('meta:lastTickLog');
console.log(logText || '(tick completed but wrote no log lines)');
// (review) Exit explicitly. Leftover timers used to keep this process alive ~2 min after
// every tick (worker.js raceTimeout fixes the cause; this is the belt to those braces).
process.exit(0);
