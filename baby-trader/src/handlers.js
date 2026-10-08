// src/handlers.js — one logged tick, exactly as the original cron handler ran it.
// Used by: the legacy KV cron (worker.js scheduled), POST /tick, and the Durable Object.
import { acquireTickLock, runTick } from './tick.js';

export async function runLoggedTick(env, label = 'tick') {
  const lines = [];
  const log = (m) => {
    const line = `[${new Date().toISOString()}] ${m}`;
    lines.push(line);
    console.log(line);
  };
  log(`=== ${label} start ===`);
  if (!(await acquireTickLock(env, log))) return lines;
  try {
    await runTick(env, log);
  } catch (e) {
    log(`TICK FATAL: ${e && e.message}`);
  }
  // Persist last tick's log for debugging (GET /log).
  try {
    await env.TRADER_KV.put('meta:lastTickLog', lines.slice(-150).join('\n'));
  } catch (e) { /* write failed — log already in console */ }
  if (label === 'manual tick') log('=== manual tick complete ===');
  return lines;
}
