// src/durable.js — run the fleet inside ONE Cloudflare Durable Object.
//
// ============================== NOTES FOR WREN ==============================
// WHY: plain Workers KV + a 1-minute cron had two real failure modes (CLOUDFLARE-NOTES.md):
//   1. KV reads can be ~60 s stale, so the next tick could read an old position
//      -> double buy / double sell.
//   2. Cron fires every minute even if the last tick is still running -> overlapping
//      ticks; the KV "lock" is itself a stale-readable KV value.
// A Durable Object fixes both:
//   * its storage is STRONGLY consistent (a read always sees the last write), and
//   * its alarm() never runs concurrently with itself, so ticks cannot overlap.
//     (Docs: https://developers.cloudflare.com/durable-objects/api/alarms/ )
//
// HOW IT RUNS: the DO re-arms its own alarm every TICK_INTERVAL_MS (default 60 s),
// measured from the START of the previous tick. The Worker's cron only calls /ensure,
// which re-arms the alarm if it ever got lost — a watchdog, not the clock.
//
// THE TRADING CODE IS UNCHANGED: runTick() gets an env whose TRADER_KV is backed by the
// DO's storage (DOStorageKV below: same get/put/delete API as Workers KV, string values).
// test/durable.test.mjs replays the golden master through this adapter: identical
// transactions, state and logs.
//
// CONTROL (all need header x-tick-token: <TICK_TOKEN secret>):
//   GET  /health[?chain=1]   status for `npm run status -- --remote` (chain=1 adds an
//                            onchain balance check, done from Cloudflare, not your PC)
//   POST /pause  /resume     kill switch: ticks stop (alarm keeps re-arming) / start again
//   POST /tick               run one tick now (skipped if one is already running)
//   POST /ensure             (re)arm the alarm loop
//   GET  /export             full state as JSON (backup)
//   POST /import             body {key: stringValue, ...} (migrate from local kv-store.json)
//   GET  /status  /log       public, read-only (same as before)
// ===========================================================================

import { BURNERS, BRAWL } from './config.js';
import { kvGet } from './kv.js';
import { runLoggedTick } from './handlers.js';

const RECENT_LOG_KEY = 'meta:recentLog';     // rolling log across ticks (for the doctor)
const RECENT_LOG_LINES = 400;
const HEARTBEAT_KEY = 'meta:heartbeat';
const PAUSED_KEY = 'meta:paused';

// Workers-KV-compatible view over Durable Object storage (string values only, like KV).
export class DOStorageKV {
  constructor(storage) { this.storage = storage; }
  async get(key) { const v = await this.storage.get(key); return v === undefined ? null : v; }
  async put(key, value) {
    if (typeof value !== 'string') throw new Error(`DOStorageKV.put requires a string value for key "${key}"`);
    await this.storage.put(key, value);
  }
  async delete(key) { await this.storage.delete(key); }
  async list() { return [...(await this.storage.list()).keys()]; }
}

const isoS = () => new Date().toISOString().slice(0, 19) + 'Z';
const json = (o, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { 'content-type': 'application/json' } });

export class TraderDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.running = false; // single instance -> an in-memory flag is a real lock
  }

  tradeEnv() { return { ...this.env, TRADER_KV: new DOStorageKV(this.ctx.storage) }; }
  interval() { return Math.max(10000, Number(this.env.TICK_INTERVAL_MS || 60000)); }

  async runOnce(source) {
    if (this.running) return { skipped: 'a tick is already running' };
    if (await this.ctx.storage.get(PAUSED_KEY)) return { skipped: 'paused' };
    this.running = true;
    const t0 = Date.now();
    let lines = [], threw = null;
    try {
      lines = await runLoggedTick(this.tradeEnv(), source === 'manual' ? 'manual tick' : 'tick');
    } catch (e) { threw = e; lines.push(`[${new Date().toISOString()}] DO TICK FATAL: ${e && e.message}`); }
    finally { this.running = false; }
    const ms = Date.now() - t0;
    const failed = !!threw || lines.some((l) => /TICK FATAL/.test(l));
    try {
      const prev = JSON.parse((await this.ctx.storage.get(HEARTBEAT_KEY)) || 'null');
      const hb = { ts: Date.now(), iso: new Date().toISOString(), ticks: (prev?.ticks || 0) + 1, lastExit: failed ? 1 : 0,
        lastMs: ms, consecutiveFails: failed ? (prev?.consecutiveFails || 0) + 1 : 0, source };
      const old = ((await this.ctx.storage.get(RECENT_LOG_KEY)) || '').split('\n').filter(Boolean);
      const recent = [...old, ...lines, `${isoS()} tick exit=${hb.lastExit} ms=${ms}`].slice(-RECENT_LOG_LINES).join('\n');
      await this.ctx.storage.put({ [HEARTBEAT_KEY]: JSON.stringify(hb), [RECENT_LOG_KEY]: recent });
    } catch (e) { console.log(`heartbeat write failed: ${e.message}`); }
    return { ran: true, ms, failed, lines };
  }

  async alarm() {
    const started = Date.now();
    try { await this.runOnce('alarm'); }
    catch (e) { console.log(`alarm tick error: ${e && e.message}`); } // never throw: Cloudflare would retry
    finally {
      // Next tick one interval after THIS one started (never earlier than 5 s from now).
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 5000, started + this.interval()));
    }
  }

  async ensureAlarm() {
    const at = await this.ctx.storage.getAlarm();
    if (at == null) await this.ctx.storage.setAlarm(Date.now() + 1000);
    return at ?? 'armed now';
  }

  authed(request) {
    return !!this.env.TICK_TOKEN && request.headers.get('x-tick-token') === this.env.TICK_TOKEN;
  }

  async health(withChain) {
    const s = this.ctx.storage;
    const positions = {};
    for (let i = 0; i < BURNERS.length; i++) {
      const v = await s.get(`wallet:${i}:position`);
      if (v !== undefined) positions[`wallet:${i}:position`] = v;
    }
    let chain = null, chainError = null;
    if (withChain) {
      try { chain = await chainBalances((this.env.RPC_URLS || 'https://mainnet.base.org').split(',').map((x) => x.trim()).filter(Boolean)); }
      catch (e) { chainError = String(e.message || e).slice(0, 120); }
    }
    return {
      mode: 'cloudflare', now: Date.now(),
      heartbeat: JSON.parse((await s.get(HEARTBEAT_KEY)) || 'null'),
      paused: !!(await s.get(PAUSED_KEY)), alarmAt: await s.getAlarm(), running: this.running,
      logLines: ((await s.get(RECENT_LOG_KEY)) || '').split('\n'),
      positions, chain, chainError,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    // Public, read-only (unchanged behavior from the KV worker).
    if (p === '/log') return new Response((await this.ctx.storage.get('meta:lastTickLog')) || '(no ticks yet)', { headers: { 'Content-Type': 'text/plain' } });
    if (p === '/status' || p === '/leaderboard') return statusResponse(this.tradeEnv());
    if (p === '/ensure') return json({ alarm: await this.ensureAlarm() }); // harmless; the cron calls it
    // Everything else needs the token. No token configured = admin disabled.
    if (!this.authed(request)) return json({ error: 'set the TICK_TOKEN secret and send it as x-tick-token' }, 403);
    if (p === '/health') return json(await this.health(url.searchParams.get('chain') === '1'));
    if (p === '/pause' && request.method === 'POST') { await this.ctx.storage.put(PAUSED_KEY, '1'); return json({ paused: true }); }
    if (p === '/resume' && request.method === 'POST') { await this.ctx.storage.delete(PAUSED_KEY); await this.ensureAlarm(); return json({ paused: false }); }
    if (p === '/tick' && request.method === 'POST') {
      const r = await this.runOnce('manual');
      return new Response(r.lines ? r.lines.join('\n') : `skipped: ${r.skipped}`, { headers: { 'Content-Type': 'text/plain' } });
    }
    if (p === '/export') return json(Object.fromEntries(await this.ctx.storage.list()));
    if (p === '/import' && request.method === 'POST') {
      const body = await request.json();
      const entries = Object.entries(body).filter(([, v]) => typeof v === 'string');
      for (let k = 0; k < entries.length; k += 100) await this.ctx.storage.put(Object.fromEntries(entries.slice(k, k + 100)));
      return json({ imported: entries.length });
    }
    return json({ error: 'unknown route' }, 404);
  }
}

// Shared by the DO and the legacy KV worker: same JSON as before.
export async function statusResponse(env) {
  const board = (await kvGet(env, 'leaderboard', []));
  const wallets = [];
  for (let i = 0; i < BURNERS.length; i++) {
    const [pos, stats, seed] = await Promise.all([
      kvGet(env, `wallet:${i}:position`, null),
      kvGet(env, `wallet:${i}:stats`, null),
      kvGet(env, `wallet:${i}:seed`, null),
    ]);
    wallets.push({ i, address: BURNERS[i], holding: !!pos, position: pos ? { ...pos, amountWei: pos.amountWei } : null, stats, seed });
  }
  return Response.json({ leaderboard: board, wallets, ts: new Date().toISOString() });
}

// Onchain balances for the doctor, fetched FROM CLOUDFLARE (so her PC makes no RPC calls).
// Small batches: public RPCs count each batch item against their rate limit.
export async function chainBalances(rpcs) {
  const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  const calls = BURNERS.flatMap((a, i) => [
    { jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: BRAWL, data: '0x70a08231' + pad(a) }, 'latest'] },
    { jsonrpc: '2.0', id: 100 + i, method: 'eth_getBalance', params: [a, 'latest'] },
  ]);
  let lastErr = 'no RPC';
  for (const rpc of rpcs) {
    try {
      const got = {};
      for (let k = 0; k < calls.length; k += 8) {
        const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.slice(k, k + 8)) });
        const res = await r.json();
        for (const x of (Array.isArray(res) ? res : [])) if (x.result != null) got[x.id] = x.result;
      }
      if (Object.keys(got).length === calls.length) {
        return { tokens: BURNERS.map((_, i) => got[i]), eth: BURNERS.map((_, i) => got[100 + i]) }; // hex strings
      }
      lastErr = `${rpc}: ${Object.keys(got).length}/${calls.length} answers`;
    } catch (e) { lastErr = `${rpc}: ${e.message}`; }
  }
  throw new Error(lastErr);
}
