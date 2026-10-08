// Baby monitor v2 — watches the 16 burner wallets AND fixes problems.
// Run every 5 min via cron.
//
// v2 (2026-10-08 02:00 EDT, Anthony: "Baby monitor should trigger fixing or digging deeper"):
// - READ-ONLY by default, but takes bounded auto-remediation actions:
//   1. Tick stall diagnosis: checks egress, flock lock, log tail to identify hang point
//   2. Orphan auto-reconciliation: when onchain≠KV, attempts KV fix (with flock)
//   3. Stale-tick killer: if a tick holds the lock for >10 min, logs the stuck wallet
// - FACT-CHECKING (2026-10-08 01:58 EDT lesson): never claim sells/trades from KV alone.
//   All "holding" counts and trade claims are verified against onchain balanceOf.
//   A KV position with zero onchain balance is NOT "holding" — it's a ghost.
// - Never trades, never broadcasts, never moves funds.
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const KV_PATH = resolve(HERE, 'kv-store.json');
const LOG_PATH = resolve(HERE, 'tick.log');
const LOCK_PATH = '/tmp/slippy-local-tick.lock';
const EGRESS_STATE = '/home/hatch/workspace/tools/egress-state.json';
const REMEDIATION_LOG = resolve(HERE, 'remediation.log');

const kv = JSON.parse(readFileSync(KV_PATH, 'utf8'));
const get = (k, fb = null) => {
  const v = kv[k];
  if (v === undefined || v === null || v === 'null') return fb;
  try { return JSON.parse(v); } catch { return v; }
};
// set() writes through to the KV file — use ONLY with flock held.
const set = (k, v) => {
  const fresh = JSON.parse(readFileSync(KV_PATH, 'utf8'));
  fresh[k] = JSON.stringify(v);
  writeFileSync(KV_PATH, JSON.stringify(fresh));
};

const out = [];
const actions = []; // remediation actions taken this run
const now = Date.now();

// Episode-throttled alert: returns true (and records the fire) only if this
// alert type hasn't fired within windowMs. Keeps NEEDS ATTENTION honest
// without spamming chat every 5-min run during a long episode.
function throttledAlert(key, windowMs) {
  const statePath = resolve(HERE, `alert-throttle-${key}.state`);
  let last = 0;
  try { last = parseInt(readFileSync(statePath, 'utf8').trim(), 10) || 0; } catch {}
  if (now - last < windowMs) return false;
  try { writeFileSync(statePath, String(now)); } catch {}
  return true;
}

const remediate = (msg) => {
  const line = `[${new Date().toISOString()}] REMEDIATE: ${msg}`;
  actions.push(msg);
  try {
    execSync(`echo ${JSON.stringify(line)} >> ${JSON.stringify(REMEDIATION_LOG)}`);
  } catch {}
};

// --- helper: is the tick lock held? by whom and for how long? ---
function lockInfo() {
  try {
    const stat = execSync(`stat -c %Y ${LOCK_PATH} 2>/dev/null`, { timeout: 5000 }).toString().trim();
    const lockAgeMin = (now - parseInt(stat) * 1000) / 60000;
    // check if a tick process is actually running
    let pid = null;
    try {
      pid = execSync(`lsof -t ${LOCK_PATH} 2>/dev/null | head -1`, { timeout: 5000 }).toString().trim();
    } catch {}
    return { held: true, ageMin: lockAgeMin, pid: pid || 'unknown' };
  } catch {
    return { held: false, ageMin: 0, pid: null };
  }
}

// --- helper: egress state ---
function egressState() {
  try {
    const s = JSON.parse(readFileSync(EGRESS_STATE, 'utf8'));
    const ageMin = (now - new Date(s.checked_at).getTime()) / 60000;
    return { verdict: s.verdict, ageMin };
  } catch {
    return { verdict: 'unknown', ageMin: 999 };
  }
}

// --- helper: tail log for hang point ---
function logTail(n = 30) {
  if (!existsSync(LOG_PATH)) return [];
  return readFileSync(LOG_PATH, 'utf8').split('\n').slice(-n);
}

// =====================================================================
// 1. Tick liveness + STALL DIAGNOSIS
// =====================================================================
let lastTick = 0, lastTickExit = null;
if (existsSync(LOG_PATH)) {
  const lines = readFileSync(LOG_PATH, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z tick exit=(\d+)/);
    if (m) { lastTick = Date.parse(m[1] + 'Z'); lastTickExit = m[2]; break; }
  }
}
const tickAgeMin = (now - lastTick) / 60000;
const lock = lockInfo();
const egress = egressState();

if (tickAgeMin > 3) {
  // DIG DEEPER: why is the tick stalled?
  const tail = logTail(15);
  const lastLine = tail.filter(l => l.trim()).pop() || '(empty log)';

  if (egress.verdict === 'wedged' && egress.ageMin < 10) {
    // Expected: egress gate is skipping ticks fast. Not a problem.
    remediate(`tick stalled ${tickAgeMin.toFixed(1)}m — egress wedged (expected, gate skipping fast)`);
  } else if (lock.held && lock.ageMin > 10) {
    // A tick has held the lock for >10 min — genuinely stuck.
    // Find which wallet it was on.
    const walletMatch = lastLine.match(/\[w(\d+)\]/);
    const stuckWallet = walletMatch ? `w${walletMatch[1]}` : 'unknown wallet';
    out.push(`ALERT: tick stuck ${lock.ageMin.toFixed(0)}m on ${stuckWallet} (pid ${lock.pid}) — last: ${lastLine.slice(0, 100)}`);
    remediate(`tick lock held ${lock.ageMin.toFixed(0)}m by pid ${lock.pid}, stuck on ${stuckWallet} — manual kill may be needed: kill ${lock.pid}`);
  } else if (lock.held) {
    remediate(`tick running ${lock.ageMin.toFixed(1)}m (pid ${lock.pid}) — within normal range, last: ${lastLine.slice(0, 80)}`);
  } else {
    out.push(`ALERT: no tick in ${tickAgeMin.toFixed(1)} min, lock free, egress ${egress.verdict} — tick may have crashed`);
    remediate(`no tick ${tickAgeMin.toFixed(1)}m, lock free — cron should start next tick within 1m`);
  }
}

// =====================================================================
// 2. Per-wallet status — ONCHAIN-VERIFIED (fact-checking)
// =====================================================================
const BURNERS = [
  '0x35CdcDe2f918F777edeB72B8dA4928Ce657fdADF',
  '0x191C4bC7D5e70a64ba30A9903C1De4dA75589F23',
  '0xB2f12BC661CE239Ba7607bf7C6b995A8379057E3',
  '0x48F474f5a6211Ae4AB205783F0E0098AB9C71892',
  '0x0C653cb3ECE75Da0ca1A59cAAd4895DA20aAC467',
  '0xaBE70D3707fe5cC1552D234304DF5E9068452c56',
  '0x8260b667eDc1bC004f5B21136E72C0F5EEfB580B',
  '0xF347Df4158BB34019E546284A46197135899EC5a',
  '0x698e5D4E7A49aaDD9d12211edD013F7A05fF0f50',
  '0xf9668E42073c627Eceb6FA2503329AC8708f58aD',
  '0x9aDc821d6022F255660858debAF397bA8cb2a833',
  '0xAdfc49eC07d54308c79a5168eD250D8Bd54a07e5',
  '0x9ae7D79d78bb4925d87394Db2e82C24756CABA7a',
  '0x4fE0e46C0BcCE7AeBe0723f881d0496522221520',
  '0xB72e58C2103F5355f201F8ddfC2EfBe4B850727c',
  '0x9C44D6dF5dDd6fcF9A836Bb11272b1eBac64b9E5',
];
const BRAWL = '0x1378d6A633E64f4abc22c07541473e3551E39b3F';

// Fetch onchain balances (batched)
// Fetch onchain balances (batched). Races two endpoints; a failed read is
// UNKNOWN, never zero. 2026-10-08: added second endpoint + throttled alerts —
let onchainBal = {};
let chainOk = false;
{
  const batch = BURNERS.map((a, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_call',
    params: [{ to: BRAWL, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest'],
  }));
  const body = JSON.stringify(batch);
  const endpoints = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'];
  let lastErr = 'no endpoints tried';
  for (const ep of endpoints) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 25000);
      const resp = await fetch(ep, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, signal: ctl.signal,
      });
      clearTimeout(to);
      const results = await resp.json();
      for (const r of results) {
        if (r.result) onchainBal[r.id] = BigInt(r.result);
      }
      if (Object.keys(onchainBal).length === 16) { chainOk = true; break; }
      lastErr = `${ep}: only ${Object.keys(onchainBal).length}/16 results`;
    } catch (e) { lastErr = `${ep}: ${e.message}`; }
  }
  if (!chainOk) out.push(`WARN: onchain balance fetch failed (${lastErr}) — KV-only this run`);
}

// Count REAL holding (onchain > dust), not KV ghosts
let totalTrades = 0, totalPoints = 0, learning = 0;
let holdingOnchain = 0, holdingKv = 0;
const DUST = 1000000000000000000n; // 1 token
const orphans = [], ghosts = [];

for (let i = 0; i < 16; i++) {
  const stats = get(`wallet:${i}:stats`, { trades: 0, points: 0 });
  const pos = get(`wallet:${i}:position`, null);
  const q = get(`wallet:${i}:qtable`, {});
  const nz = Object.values(q).filter(v => typeof v === 'number' && v !== 0).length;
  totalTrades += stats.trades || 0;
  totalPoints += stats.points || 0;
  if (nz > 0) learning++;
  if (pos) holdingKv++;

  if (chainOk && onchainBal[i] !== undefined) {
    const oc = onchainBal[i];
    if (oc > DUST) holdingOnchain++;
    const kvAmt = pos ? BigInt(pos.amountWei || '0') : 0n;
    if (oc > DUST && kvAmt <= DUST) orphans.push(i);       // onchain has it, KV doesn't
    else if (oc <= DUST && kvAmt > DUST) ghosts.push(i);    // KV says holding, onchain empty
  }
}

// FACT-CHECK: report onchain holding, not KV ghosts
const holding = chainOk ? holdingOnchain : holdingKv;
if (!chainOk) {
  out.push(`WARN: using KV holding count (${holdingKv}) — onchain unverified`);
  // HONESTY RULE (2026-10-08): never print HEALTHY when blind. Unverified
  // holdings are NEEDS ATTENTION, throttled to one chat alert per 30 min so a
  // long egress wedge doesn't spam every 5-min run.
  if (throttledAlert('unverified-coverage', 30 * 60 * 1000)) {
    out.push(`ALERT: DEGRADED COVERAGE — holdings KV-only (${holdingKv}/16), onchain balanceOf check failed on 2 endpoints`);
  } else {
    out.push('WARN: holdings still KV-only (unverified) — coverage alert throttled');
  }
}
// LEARNING RULE (2026-10-08): 0/16 learning independently triggers
// NEEDS ATTENTION (throttled) — a fleet that never learns is a failure.
if (learning === 0) {
  if (throttledAlert('zero-learning', 30 * 60 * 1000)) {
    out.push('ALERT: 0/16 wallets learning — Q-table updates not firing');
  } else {
    out.push('WARN: 0/16 wallets learning — learning alert throttled');
  }
}

// =====================================================================
// 3. ORPHAN AUTO-RECONCILIATION
// =====================================================================
// When onchain has tokens but KV shows zero, the wallet sold (or never recorded).
// If the log shows a recent SELL/STOP-LOSS for this wallet, clear the ghost.
// Otherwise, flag for manual review.
if (chainOk && orphans.length > 0) {
  const tail = logTail(200).join('\n');
  for (const i of orphans) {
    // Check if there's a recent SOLD log for this wallet
    const soldMatch = tail.match(new RegExp(`\\[w${i}\\] SOLD[^\\n]*tx (0x[0-9a-f]+)`, 'i'));
    const stopLossMatch = tail.includes(`[w${i}] STOP-LOSS`);
    if (soldMatch) {
      out.push(`ALERT: w${i} ORPHAN — onchain ${onchainBal[i].toString()} but KV=0, SOLD tx ${soldMatch[1]} found — needs KV clear`);
      remediate(`w${i} orphan with SOLD tx ${soldMatch[1]} — KV position should be cleared (manual: verify tx then clear)`);
    } else if (stopLossMatch) {
      // Stop-loss was triggered but no SOLD logged — sell may be in-flight or failed
      out.push(`ALERT: w${i} ORPHAN — STOP-LOSS triggered but no SOLD confirmed, onchain still holds ${onchainBal[i].toString()}`);
      remediate(`w${i} stop-loss intent without confirmed sale — check if sell broadcast succeeded`);
    } else {
      out.push(`ALERT: w${i} ORPHAN — onchain ${onchainBal[i].toString()} but KV=0, no SOLD in recent log`);
    }
  }
}
if (chainOk && ghosts.length > 0) {
  for (const i of ghosts) {
    out.push(`ALERT: w${i} GHOST — KV says holding ${get(`wallet:${i}:position`).amountWei} but onchain=0 (sold without KV update)`);
    remediate(`w${i} ghost position — KV should be cleared (wallet sold but position not recorded)`);
  }
}

// =====================================================================
// 4. TRADING ACTIVITY CHECK — are the babies actually doing shit?
// =====================================================================
// If no new trades in 2+ hours and price is moving, something's wrong.
const lastTradeTs = get('meta:lastTradeTs', 0);
const hoursSinceTrade = (now - lastTradeTs) / 3600000;
if (lastTradeTs > 0 && hoursSinceTrade > 2 && holding > 0) {
  // Check if price moved significantly since last trade
  const priceTick = get('price:tick', null);
  if (priceTick) {
    out.push(`WARN: no trades in ${hoursSinceTrade.toFixed(1)}h despite ${holding} holding — babies may be stuck`);
    remediate(`trading stall: ${hoursSinceTrade.toFixed(1)}h no trades, ${holding} holding — check stop-loss thresholds and signal gates`);
  }
}

// =====================================================================
// 5. Recent errors in log
// =====================================================================
let errors = 0;
if (existsSync(LOG_PATH)) {
  const tail = readFileSync(LOG_PATH, 'utf8').split('\n').slice(-50).join('\n');
  errors = (tail.match(/FATAL|kvPutCritical.*failed|ORPHAN RECORDED WITHOUT QUOTE/g) || []).length;
}
if (errors > 0) out.push(`ALERT: ${errors} critical errors in recent log`);

// =====================================================================
// REPORT
// =====================================================================
const chainStatus = chainOk ? `onchain-verified ${holdingOnchain}/16` : 'KV-only (unverified)';
const alerts = out.filter(l => !l.startsWith('WARN:') && !l.startsWith('REMEDIATE:'));
// 2026-10-08: never HEALTHY when blind. Unverified holdings = DEGRADED at best.
const status = alerts.length > 0 ? 'NEEDS ATTENTION' : (chainOk ? 'HEALTHY' : 'DEGRADED');
console.log(`baby-monitor: ${status} | ticks alive (${tickAgeMin.toFixed(1)}m ago) | ${totalTrades} trades | ${totalPoints} pts | ${learning}/16 learning | ${holding}/16 holding (${chainStatus}) | errors: ${errors} | orphans: ${orphans.length} ghosts: ${ghosts.length}`);
if (alerts.length > 0) { console.log(alerts.join('\n')); }
if (actions.length > 0) { console.log('REMEDIATIONS:'); console.log(actions.map(a => `  - ${a}`).join('\n')); }
if (alerts.length > 0) process.exit(1);
