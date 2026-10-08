# Cloudflare audit + running locally

Audit of `worker.js` (2026-10-08) for Cloudflare Workers limits. **Every number below was measured.** I ran real `worker.js` ticks against `test/helpers/fake-chain.mjs` and counted every subrequest, KV call and CPU millisecond. `test/local-runner.test.mjs` re-checks the worst case on every `npm test`.

**Not audited:** `wrangler.toml` / deploy config. It isn't in the package. See the checklist at the end.

**Plan limits** are as I know them for Workers Paid. Re-check Cloudflare's current limits page before relying on them.

| Limit | Workers Paid | Free |
|---|---|---|
| Subrequests (fetch + RPC) per invocation | 1,000 | 50 |
| CPU time per invocation | 30 s default (configurable) | 10 ms |
| KV operations per invocation | 1,000 | 1,000 |
| KV writes to the **same key** | 1 per second (else 429) | same |
| KV read consistency | eventual: up to ~60 s stale | same |
| KV writes per month / per day | 1M/month included, then billed | 1,000/day |
| Cron wall time | up to 15 min per invocation | same |

## 1. Measured cost of one tick (16 wallets)

| Tick type | Subrequests (RPC + HTTP) | KV gets | KV puts | Same-key puts < 1 s apart | CPU |
|---|---|---|---|---|---|
| All 16 buy | 168 (149 + 19) | 340 | 243 | 66 | 88 ms (420 ms cold start) |
| All 16 sell | 296 (261 + 35) | 370 | 236 | 61 | 134 ms |
| 16 holding, no exit (typical) | 88 (69 + 19) | 274 | 60 | 16 | 48 ms |
| Quiet tick | 24 (21 + 3) | 241 | 28 | 0 | 35 ms |

The fake chain answers instantly and needs no Permit2 re-quotes or approvals. Real ticks are **higher**; see §2.4.

## 2. What is at risk on Cloudflare, worst first

### 2.1 Overlapping ticks plus stale KV reads (money risk)
- **The trigger:** the cron fires every minute whether or not the last tick finished. A tick can run far past 60 s:
  - up to 45 s per wallet and 120 s per batch × 4 batches (`WALLET_TIMEOUT_MS` / `BATCH_TIMEOUT_MS`, worker.js:3092–3093),
  - a 90 s receipt wait (`waitReceipt`, :971),
  - then 6 × 10 s balance re-checks (:1698, :2087).
- **The lock is unreliable:** `acquireTickLock` (:3145) is a timestamp in KV. KV reads can be up to ~60 s stale, so two invocations can both see an old lock and both run.
- **The money risk:** each invocation then reads `wallet:{i}:position` (:2352), possibly stale, and can **buy twice or sell a position the other run already sold.**
- **Free plan:** irrelevant here; the problem exists on any plan.

### 2.2 KV's 1-write-per-second-per-key limit (429s, lost writes)
Measured: 16–66 same-key writes per tick, under a second apart. All of these fail after the first with HTTP 429.
- **The random-number state** `wallet:{i}:rng` is written after combo selection (:2453), then again on every holding-branch exit (:2568, :2606, :2621, :2627, :2648, :2653). After a sell, that second write throws, so `processWallet` fails with "TICK ERROR" *after* the money already moved.
- **Fleet-wide logs:** `fleet:sellLog` (:1968), `arena:recentRewards` / `arena:avgReward` (:1978) and `fleet:buyLog` (:1747) are rewritten once per wallet that trades, up to 16× in one tick. They sit inside try/catch, so entries are dropped silently.
- **`wallet:{i}:pendingBuy`** is written twice per buy (write-ahead, then clear). The clear threw after the buy had landed, skipping `lastTrade` and the buy log. **Fixed** in this change: the clear can no longer throw.
- `kvPutCritical` (:573) retries after 1 s and 2 s, which is exactly the 429 recovery pattern. "kvPutCritical attempt 1/3 failed" lines, and the 20:11Z orphan ("buy tx landed, KV write failed"), are consistent with this. That's plausible, but your logs don't prove it.

### 2.3 KV operations per invocation
- **Measured:** buy and sell ticks use 583–606 KV operations, about 60% of the 1,000 cap. Real ticks read more (approvals, re-quotes, orphan checks).
- **The fleet-expansion plan:** per-coin keys (`docs/original/FLEET-MIGRATION-PLAN.md` Phase B) multiply this by the number of coins. **2+ coins would cross the cap.**

### 2.4 Subrequests
- **Measured worst case:** 296 for a 16-sell tick, before any retries.
- **What real ticks add on top:**
  - Each sell does a Permit2 re-quote: +16.
  - Each transaction polls `eth_getTransactionReceipt` every 3 s for up to 90 s: up to 30 calls, then 6 balance checks.
- **Worst-case total:** a slow block during a 16-sell tick adds up to ~580, for **~880 of 1,000**. On Free (50) every non-quiet tick fails.

### 2.5 CPU: not at risk on Paid
35–134 ms per tick (420 ms on a cold start), well under 30 s. On Free (10 ms) every tick exceeds it.

### 2.6 Monthly KV writes: cost, not failure
- **Per tick:** 28 (quiet) to 60 (holding) writes, × 43,200 ticks per month.
- **Total:** ~1.2M–2.6M writes per month, against 1M included. Expect a small overage bill.

### 2.7 Security: anyone could trigger a trading tick
- **The hole:** `POST /tick` (:3182) ran a real trading tick for anyone who knew the worker URL.
- **Fixed:** set the `TICK_TOKEN` secret and send it as the `x-tick-token` header. With the secret set, other requests get 403. Unset keeps the old open behavior, so an existing external ticker doesn't break silently.

### What the docs show about past trouble
- `docs/original/README.md` says the system already moved off Cloudflare to a local runner, using Cloudflare's same `scheduled()` entry point.
- `cron-test:lastFire` is "residue from a Cloudflare cron diagnostic on 2026-10-07".
- **No recorded root cause.** None of the docs say what broke. Items 2.1 and 2.2 are what this code would hit under a 1-minute cron.

## 3. Running it from a local PC (changes in this patch)

**Zero Cloudflare dependency on the hot path.** `worker.js` only uses `env.TRADER_KV` (`get`/`put`) and global `fetch`, with no `cloudflare:*` imports and no `ctx.waitUntil`. Locally, `env.TRADER_KV` is `LocalKV`, so the trading code is byte-for-byte the same code path.

| Change | File | Why |
|---|---|---|
| **Scheduler** that never overlaps ticks | `local-runner/loop.mjs` (new) | Waits for each tick to exit, then starts the next. One child process per tick. Heartbeat file. Rotating `tick.log` with the `<ISO>Z tick exit=N` lines `baby-monitor.mjs` parses. Hang watchdog at 15 min, far beyond every internal timeout. |
| **OS process lock** | `local-runner/run-tick.mjs` | Exclusive `<KV_FILE>.lock` holding the PID. A live lock skips the tick; a dead PID (crash/reboot) is taken over. Replaces relying on the 45 s KV timestamp lock. |
| Keep the existing **flock** | `loop.mjs` (`TICK_FLOCK`) | Wraps each tick in `flock /tmp/slippy-local-tick.lock`, so the hourly KV backup, MERGE-PLAN surgery and the monitor keep excluding ticks like before. |
| **Write coalescing** | `local-runner/kv-local.mjs` + `run-tick.mjs` | Every put used to rewrite and fsync the whole ~690 KB store. Measured: 243 puts = 85 MB / 1.2 s per buy tick; 60 puts = 42 MB per holding tick (~60 GB/day). Now money-critical keys (`position`, `pendingBuy`, `lastTrade`, `meta:tickLock`) still reach disk **before** `put()` returns; everything else flushes once per tick. Measured after: holding tick 2 fsyncs / 1.4 MB / 44 ms; buy tick 66 fsyncs / 47 MB. `KV_WRITE_THROUGH=1` restores the old behavior. |
| Egress-gate path | `run-tick.mjs` | `EGRESS_STATE_FILE` env (the default is the old hard-coded path). |
| Write-ahead clear can't throw | `worker.js` | §2.2. Error path only; a buy is never affected. |
| `TICK_TOKEN` | `worker.js` | §2.7. Fetch handler only; local ticks never use it. |

Money-path behavior is unchanged: same decisions, same transactions, same values written. Only the error handling on one write and *when* non-critical values reach disk changed.

### How to run it

```bash
npm install && npm test                       # 25/25
# remove any old per-minute cron line that calls run-tick.mjs
KEYS_FILE=~/keys.json KV_FILE=~/baby/kv-store.json DRY_RUN=true \
RPC_URLS="https://<your-keyed-rpc>,https://base-rpc.publicnode.com,https://mainnet.base.org" \
TICK_FLOCK=/tmp/slippy-local-tick.lock \
  pm2 start local-runner/loop.mjs --name babies     # or systemd / Task Scheduler (Windows: omit TICK_FLOCK)
*/5 * * * *  node local-runner/baby-monitor.mjs      # unchanged; reads tick.log + 1 batched RPC
```

Go live by dropping `DRY_RUN=true` only after a day of clean dry ticks. Watch for `tick exit=0` lines and `heartbeat.json` updating every minute.

### Staying inside RPC limits

- **What a tick costs:** 21 RPC calls when quiet, ~70 when holding, 150–260 in a tick where everyone trades, all within a few seconds.
- **Public RPCs** (publicnode, mainnet.base.org) rate-limit bursts like that. Your logs show 429s and "egress wedged".
- **The fix:** put a free-tier **keyed RPC** first in `RPC_URLS` and keep the public ones as fallback. The worker already tries them in order (:2834).
- **Monitoring is cheap:** `baby-monitor.mjs` makes one batched call (16 `balanceOf`) per run. At every 5 min that's 288 batches a day. `loop.mjs` adds no network calls.
- **Egress discipline (already in the code):** `run-tick.mjs` skips in under a second when the egress state file says `wedged`/`down`. The worker safe-aborts when no RPC returns a price. Failed reads are treated as *unknown*, never as zero.

### Known gaps (not changed; flagged)

- **Mislabeled monitor alerts:** in `baby-monitor.mjs`, "ORPHAN" (onchain has tokens, KV doesn't) is described in its remediation text as "the wallet sold". It's actually the reverse case. The alert text is misleading, but no automated action depends on it.
- **No `wrangler.toml` to audit.** If you ever redeploy to Cloudflare, check:
  - The cron is `* * * * *`.
  - The CPU limit isn't lowered below a few seconds.
  - `TICK_TOKEN` is set.
  - **Positions and the tick lock move from KV to a Durable Object** (strongly consistent, a real lock). Without that, §2.1 remains.
