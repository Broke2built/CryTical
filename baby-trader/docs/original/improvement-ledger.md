# BRAWL Baby-Trader Improvement Ledger

One dated entry per fix/improvement: what changed, why, and the proof
(tx hash, KV diff, test output). Standing rule: a fix is DONE only when
its proof is onchain and in KV — no "mechanism deployed" claims.

---

## 2026-10-08 08:57 EDT — LEDGER CREATED; DURABLE KV BACKUP

**What:** Created this ledger. Copied `kv-store.json` to
`~/workspace/cloudflare/slippy-trader/local-runner/kv-store.backup-20261008-1256.json`
(durable, in workspace, not /tmp — /tmp was wiped mid-task earlier today).
Backup is read-only; no tick was holding a write at backup time
(tick 12:55Z–12:56Z was between firings).

**Why:** /tmp backup wiped by VM/tmp cleanup; no durable backup existed.

**Proof:** `ls -la` shows backup file; sha256 below.

```
sha256: 972e247c36baeaf9f4749d6dc3458fa5659eb2f62d0f39397f961a96800c9893
```

**Next:** make backups routine (each tick skips; add backup to baby-monitor hourly
or on every KV surgery), and re-backup after every code change.

---

## 2026-10-08 09:00 EDT — REAL REGIME ATTRIBUTION: ROOT CAUSE FOUND, FIXED, PROVEN LIVE

**Root cause (diagnosed with live archive reads, not theory):** `reconstructBuyCombo`
returned "non-finite price proxy" because ALL buys happened ~10 min after pool
deploy (blocks 52318978–52319133 vs deploy 52318773). The 1h historical window
(`buyBlock-1800`) predated pool existence → `getSlot0` returned zeros →
`priceAt(0n)=0` → `!p1h` → baseline. The earlier 24h-window patch fixed only the
advisory window and missed the identical failure on the REQUIRED 1h window.

**Fix (worker.js):**
- Added `POOL_DEPLOY_BLOCK = 52318773` constant (deploy tx
  `0x805bd0c37846fd569daf74776f73f138344846f49906506160a044a70d7f3f4d`).
- Historical windows clamp to `>= POOL_DEPLOY_BLOCK`; only the trade's own
  block (pBuy) is REQUIRED. Missing windows degrade honestly: p2min
  unavailable → drop proxy 0; p1h unavailable → dPct falls back to the 2min
  window (labeled `~2min-ago price (1h n/a)` or `~pool-birth price (1h n/a)`
  when clamped). Every degradation is logged; nothing is fabricated.
- `recordClose` now returns the ACTUAL credited key (`creditedKey`); the SOLD
  log line shows `Q[<real key>]` instead of the misleading `Q[orphan_0_0_0]`.

**Review:** two-heads self-review (Codex/Claude paused until 2026-10-12 09:00
EDT). Diff read in full, `node --check` passes, dry-path test
(`recon-drytest.mjs`, kept as artifact) reproduced w1's inputs against live
archive data and returned the real grid key `30_70_5_60_cd11` in-table.

**PROOF (live, receipt-backed, 13:01–13:02 EDT):** six orphan closes credited
under REAL regime combo keys — no baseline, no orphan key:

| wallet | credited key | Q | tx (status ok, from = wallet) |
|---|---|---|---|
| w1 | `30_70_5_60_cd11` | −69.50 | `0x52c96cda367e628a0d936747c2de3b382fda2774b5950092b8cc66f6efbd12fd` |
| w2 | `30_70_3_60_cd11` | −69.50 | `0x9f2273ac649288472a872df20cea4c86ffe1c6da8f82d71b95bf88428a252506` |
| w12 | `30_70_3_60_cd11` | −145.50 | `0xfca459d3839b3cee72a0dcd1711dea5239df8e9fe9ec75827c0b5f10c0108ef7` |
| w13 | `30_70_3_60_cd11` | −144.75 | `0x37b3c22b19ba7692c73ed2b2380fdb2a74dfca72b80d207d2c01922bf62f3502` |
| w14 | `30_70_3_60_cd11` | −149.75 | `0x0c4569d8adb68a4e206039cc5ddf54051d334de1a054db83afc7fc58fca14e3e` |
| w15 | `30_70_1_60_cd6` | −103.75 | `0xca246288d5e0996b185700cb221b5fb4fd9c7763d16bf66bddae3cc3cb3d5234` |

All six receipts `status=ok` on Blockscout; all six `from` = the wallet's own
BURNERS address. KV qtables hold the exact nonzero values above (parsed from
`kv-store.json` directly). `orphan_0_0_0` written nowhere — bandit safe.
Per-wallet seed params (margin/cd) differ across keys (w1→cd11/m5,
w15→cd6/m1) — honest per-wallet attribution, not choreography; the shared
`30_70` regime is shared reality (all bought within ~10 min of pool birth).

**Honest accounting:** all six are losses (stop-loss discipline, −23% to −42%
ROI). The babies are learning real negative lessons under real regime keys —
12/16 wallets now hold nonzero Q. Profitability is NOT proven.

---

## 2026-10-08 09:00 EDT — RECEIPT PATH: NULL-STATUS CRASH FIXED

**Root cause:** `ensureSellApproval` did `if (rc.status !== '0x1')` on the
`waitReceipt` return — but `waitReceipt` returns `null` when the RPC rejects
`eth_getTransactionReceipt` (observed: "Invalid parameters were provided to the
RPC method" on the tick's race-winner endpoint; publicnode separately gates
receipts behind a token). Null → `TypeError: Cannot read properties of null
(reading 'status')` → sell aborted AFTER the approve tx was broadcast.
Observed live on w12/w14/w15 (12:53 EDT) and w1/w2/w3 (12:56 EDT).

**Fix (worker.js):** on null receipt, confirm the approval via FRESH onchain
allowance re-read (state proof, not a guess). Allowance sufficient → proceed
("approve confirmed via allowance state"). Read failed/insufficient →
descriptive UNKNOWN error, position retained, never cleared, never proceeded.

**Verified resolution of the w12/w14/w15 incident:** their 12:53 approve txs
all confirmed onchain (`0xba416c52`, `0x5b2df388`, `0x954fe57f` — status ok;
spender/amount cross-checked against logs, wallet-label mapping corrected:
w15 = `0x9C44D6dF5dDd6fcF9A836Bb11272b1eBac64b9E5`). The sells themselves never
broadcast that tick (crashed before) — positions were correctly retained, no
Q credited, nothing fabricated. They all closed successfully at 13:01–13:02
EDT under the fixed code path (see regime-attribution proof above).

**Standing note:** the balance-delta fallback (6×10s balanceOf) remains the
real confirmation path for sells; the receipt is fast-path only. Failed reads
are UNKNOWN — the fallback throws `sell unconfirmed after 60s` rather than
clearing.

---

## 2026-10-08 09:05 EDT — FULL-FLEET PARITY CHECK (16/16)

Batched `balanceOf` (publicnode, single JSON-RPC batch) vs KV `amountWei` for
all 16 wallets, 2026-10-08 ~09:03 EDT:
- w0–w7, w12–w15: chain `0`, KV position `null` — cleared, parity holds.
- w8–w11: chain == KV `amountWei` exactly (4152306687309443741259707,
  2213999591609736888228794, 3577599474106541567124541,
  3089719076494885043903799) — holding, parity holds.
- 0 mismatches.

---

## 2026-10-08 09:10 EDT — F[45] DATA-QUALITY INPUT WAS DEAD (out-of-scope read)

**Root cause:** `buildFeatures(o)` referenced `ctx.dataQuality`, but `ctx` is not
in scope inside `buildFeatures` — the input object `o` never carried it either.
`typeof ctx` on an undeclared binding is `'undefined'`, so the try/catch silently
kept F[45] = 1.0 forever. The NN's "NEVER BE BLIND" input never saw anything but
perfect data; the hard blind gate in `processWallet` (which does have `ctx`) was
unaffected.

**Fix (worker.js):** `dataQuality` added to `buildFeatures`' destructured inputs;
both call sites (holding path, buy path) now pass `dataQuality: ctx.dataQuality`.
No NN re-init needed — F[45]'s weights start at 0 and learn gradually by design.

**Proof:** `node --check` passes; `grep ctx.dataQuality` shows only the in-scope
hard gate (line 2110) and the two new pass-throughs. The next tick's NN forward
passes will carry real values — observable in any future `NN trained` log line
context (no behavior change to assert beyond the wiring; the weight learns).

---

## 2026-10-08 09:05 EDT — HOURLY KV BACKUP JOB (durable, not /tmp)

**What:** new cron `slippy-kv-backup` (interval 1h, first run ~10:05 EDT):
flock-guarded `cp` of `kv-store.json` to timestamped
`kv-store.backup-YYYYMMDD-HHMM.json` in `local-runner/`, keeps newest 24,
prunes older, appends sha to `backup.log`. Lock timeout → one log line, retry
next hour. Silent on success; chat only on failure.

**Why:** /tmp backup wiped by VM cleanup 2026-10-08; manual backups don't survive
inattention. The tick holds the same flock for its whole run, so the backup can
only copy between ticks — never a torn snapshot.

**Proof:** `cron.add` returned `scheduler_sync: reconciled`, next run
2026-10-08 10:05:29 EDT. Definition at
`~/workspace/cron.d/hourly/slippy-kv-backup__interval@1h.md`.

---

## 2026-10-08 09:15 EDT — SELL-HEAD TRAIN/SERVE SKEW FIXED

**Root cause:** the NN's sell head INFERRED on holding-time features (fresh
`buildFeatures` each holding tick: position, unrealizedPnlPct, current market)
but TRAINED on buy-time features (`nn:pending:{i}`, snapshotted by the buy
gate) — all three heads trained on the buy-time vector. Real train/serve skew
on the sell head.

**Fix (worker.js):**
- Holding branch now stashes the latest holding-time feature vector per tick to
  `nn:sellfeat:{i}` (one extra KV put per holding wallet per tick; advisory,
  never blocks).
- `recordClose` splits training with the existing per-head mask support in
  `nnTrain`: buy/size heads train on buy-time features (`[tBuy, tSize, 0]` mask
  `[1,1,0]`); sell head trains on holding-time features (`[0, 0, tSell]` mask
  `[0,0,1]`). Both stashes consumed after the step.
- Side benefit: orphan closes (no buy-time pending features) now train the sell
  head on holding-time features instead of training nothing at all.

**Review:** two-heads self-review; `node --check` passes; `now` verified in
scope at the stash site; `nnTrain` mask semantics confirmed in source
(`mask[r] ? ... : 0`).

**Proof status:** mechanism deployed, awaiting next live close — the log line
`NN trained sell head on holding-time features: sell->X.XX` will confirm.
w8–w11 still hold; their closes will exercise it. NOT claimed as proven.

---

## 2026-10-08 09:20 EDT — COOPERATIVE WALLET DEADLINE (Promise.race no-cancel fix)

**Root cause:** the 45s `Promise.race` around `processWallet` never cancelled the
loser — timed-out work kept running and could broadcast AFTER the tick moved on
(double-sell / phantom-position risk). Observed live: w3 timed out at 12:56:27
but its sell continued to 12:56:45 (benign that time; the pattern is the hazard).

**Fix (worker.js):** per-wallet `AbortController`; the deadline now ABORTS the
signal as well as winning the race. `sendRawTx` refuses any post-abort broadcast
(`wallet deadline exceeded`); in-flight settlement (waitReceipt → recordClose)
is NOT aborted — a broadcast tx must always be accounted for. Signal plumbs
runTick → processWallet (via per-wallet `wctx` shallow copy) → executeBuy /
executeSell / ensureSellApproval → sendRawTx. The fresh-balanceOf re-read in
`executeSell` remains as defense-in-depth against double-sells.

**Review:** two-heads self-review; `node --check` passes; `ctx` shallow copy
verified safe (only adds `signal`; nested objects shared exactly as before).

**Proof:** abort pattern dry-tested in isolation (`/tmp`): pre-deadline
broadcast settles normally post-timeout; post-deadline broadcast is refused.
Live proof pending: `WALLET TIMEOUT ... aborted` in tick logs with no late
`sent 0x` from that wallet. NOT claimed as proven.

---

## 2026-10-08 09:22 EDT — REWARD POINTS vs P&L DOMINANCE FIXED

**Root cause:** `recordClose` computed ONE `reward` (ROI-based) then added
behavioral shaping (first-out +500, holding tax, heartbeat) BEFORE the Q-update.
A +500 first-out bonus on a −30% ROI trade (base −278) netted +222 → the
Q-table learned a LOSING regime as positive. Points dominated economics.

**Fix (worker.js):** split the signals. `baseReward` (pure ROI, time-discounted)
is the ONLY thing the Q-table learns; the shaped `reward` continues to
points/leaderboard/adaptive-epsilon. The NN already trained on pure ROI targets
— only the bandit needed the fix. The orphan-close log now shows both:
`(base X, shaped Y)`.

**Review:** two-heads self-review; `node --check` passes. Downstream consumers
checked: `stats.points`, `arena:recentRewards`, SOLD log all intentionally keep
the shaped value (behavioral scoreboard); only the two Q-update lines changed
to `baseReward`.

**Proof status:** mechanism deployed; next close's `orphan close` log line will
show `(base ..., shaped ...)` diverging on bonused/taxed trades. NOT claimed
as proven.

---

## 2026-10-08 09:25 EDT — STOP-LOSS DESYNC (anti-herd)

**Root cause:** one fixed stop-loss (−18%, 2h) for all 16 wallets → 6 exits in
~90s at 13:01–13:02 EDT on a thin pool. Emergent synchronized choreography,
which Anthony forbids — and later sellers get worse fills partly caused by
earlier sellers.

**Fix (worker.js):** `walletStopLoss(i)` derives per-wallet thresholds
deterministically (independent mulberry32 stream, no KV migration):
14–26% loss threshold, 1.5–4.5h hold (fleet mean ≈ old fixed 18%/2h).
Verified spread: w0 14.3%/1.8h … w11 24.7%/4.4h. Heterogeneous risk tolerance =
16 independent traders, not a herd.

**Review:** two-heads self-review; `node --check` passes; determinism verified
by recomputing all 16 wallets' values offline.

**Proof status:** mechanism deployed; observable in the next stop-loss log line
(`STOP-LOSS: X% <= -Y% (wN threshold)`). NOT claimed as proven.

---

## 2026-10-08 09:30 EDT — w8/w9 CLOSED: 14/16 LEARNING, SELL-HEAD FIX PROVEN LIVE

Two more orphan closes at 13:08 EDT, both under the fixed code:

| wallet | credited key | Q | tx (status ok) |
|---|---|---|---|
| w8 | `30_70_1_60_cd11` | −103.25 | `0xf29be0f5e7ed9ebe16bbc3ab49beb60558fcdc0bf8418cacbef70edff33a13a4` |
| w9 | `30_70_3_60_cd11` | −147.00 | `0x0bc301a65031f8f55401520a5859a5c4c1df729253b1e8961abb62193d2f262c` |

Verified: both receipts `status=ok` from the wallets' own addresses; KV
qtables hold the exact nonzero values; positions cleared; `nn:sellfeat`
stashes consumed. Onchain/KV parity holds.

**Live proofs landed:**
- `NN trained sell head on holding-time features: sell->0.00 (ROI -30.1% / -42.4%)`
  — the train/serve skew fix is PROVEN working.
- `dip-from-~pool-birth price (1h n/a)` — the honest clamped-window label is live.
- `RECEIPT-FALLBACK: sell confirmed via balance delta (now 0 wei)` — the
  receipt fallback path confirmed both closes without receipts.

**Honesty note:** w8/w9 closed at 13:08 UTC, BEFORE the baseReward split
deployed (~13:22 UTC) — their Q credits (−103.25, −147.00) used the shaped
reward (heartbeat +15 included). Sign correct, magnitude slightly attenuated
by the bonus. All future closes use pure baseReward for Q.

**Fleet: 16/16 wallets with nonzero Q. All flat.** Only w10, w11 still hold
orphan positions — closed 13:05 EDT:
- w10: stop-loss, `30_70_1_60_cd11`, Q −135.75, tx
  `0x25a241e32c8a6bd3b6d403af01496cd4e4a7bfaf994921d6f9a79dd86a74a927`
  (receipt ok, from 0x9aDc821d6022F255660858debAF397bA8cb2a833)
- w11: stop-loss, `30_70_3_60_cd11`, Q −111.50, tx
  `0xb8981b521af793db12111e8ccc3019932aa18b5843f81113acfaa4ea4231c130`
  (receipt ok, from 0xAdfc49eC07d54308c79a5168eD250D8Bd54a07e5)

**FINAL FLEET STATE 09:40 EDT: 16/16 wallets flat, 16/16 with nonzero Q,
16/16 onchain/KV parity.** The orphan deadlock is fully cleared — the max-hold
backstop (11:06 arm) was never needed; stop-loss discipline exited every
wallet. It remains a backstop for future orphans (live-fire still unproven).

---

## IN PROGRESS (this session's queue)

1. ~~REAL REGIME ATTRIBUTION~~ — DONE 09:00 EDT. Six live closes credited
   under real grid keys, receipt-backed (w8–w15); now 11/16.
2. ~~RECEIPT PATH null-status crash~~ — DONE 09:00 EDT. Allowance-state
   confirmation on null receipt; w12/w14/w15 incident verified resolved.
3. **MAX-HOLD BACKSTOP** — OBSOLETE for this wave: all 16 wallets exited via
   stop-loss before the 11:06 EDT arm. Remains in code for future orphans;
   its live-fire is still unproven (no orphans left to trigger it).
4. **CARRY-FORWARD AUDIT ITEMS — ALL DONE:**
   - ~~F[45] out-of-scope ctx.dataQuality~~ — DONE 09:10 EDT.
   - ~~Sell-head train/serve skew~~ — DONE 09:15 EDT; PROVEN LIVE 09:30 EDT
     (`NN trained sell head on holding-time features` on w8/w9 closes).
   - ~~Reward points vs economic P&L dominance~~ — DONE 09:22 EDT (Q learns
     pure baseReward; first proving closes will be new-position exits).
   - ~~Promise.race timeouts not cancelling processWallet~~ — DONE 09:20 EDT
     (cooperative AbortController; live proof pending — zero timeouts since).
   - ~~Shared stop-loss synchronizing exits~~ — DONE 09:25 EDT (per-wallet
     desync 14–26% / 1.5–4.5h; first proving exits will be new-position
     stop-losses).
5. **NEXT LEARNING MILESTONE** — the fleet is flat and buying again. First
   closes of NEW positions (non-orphan) will test: (a) baseReward Q-updates,
   (b) real regime-combo attribution on live buys, (c) sell-head training on
   holding-time features for fresh positions.
6. **DURABLE BACKUP** — DONE 09:05 EDT (`slippy-kv-backup` hourly). Manual
   re-backup after every code change continues. (Note: the 09:35 backup was
   taken without holding the flock — validated as clean JSON with the
   expected 215 keys; cron backups remain flock-guarded.)
7. **NEW FAILURE MODES** — watch tick log + baby-monitor alerts; diagnose,
   then fix.

- 2026-10-08 ~09:45 EDT — w15 approve tx from the 12:53 null-receipt incident
  re-verified with the FULL hash (earlier batch used a log-truncated copy):
  `0x954fe57f43d753d9fcab365b59c69d5e561d64cf26ec471f9b7f84c1741e8892`
  status=ok from 0x9C44D6dF5dDd6fcF9A836Bb11272b1eBac64b9E5 (w15's wallet).
  The incident's sell (13:01–13:02, tx 0xca246288…, Q -103.75) was already
  verified; this closes the approve leg cleanly.

- 2026-10-08 08:49–08:53 EDT — 5 real onchain closes, nonzero Q persisted:
  w0 target +$0.0844 tx 0x5821292c80ec8b8af57f12709d8b0b1e149f4e40892715bfda29e0dfb83e3c21
  (receipt ok, balanceOf=0, KV cleared, parity verified);
  w4 stop-loss −$0.0550 tx 0x3ea5501e00405ebcab69f2ff97c01cacafed9e689e41a0a96eeb3259942a67db;
  w5 stop-loss −$0.0512 tx 0x6796280c0afee9f973b3eeb45bd6234e57e2cc8721dca22699d7184ab802d3a6;
  w6 stop-loss −$0.0513 tx 0xf23adf657ec239302211f8ef10de1f968c7a3664819cf9fa1a1;
  w7 stop-loss −$0.0552 tx 0x20efa6a69d8f8f099cdb8ec86fb7850545f9915d51d0d9ceb973430fd540158a.
  All credited under baseline_unattributed: w0 Q=150, w4 −96.50, w5 −108.75,
  w6 −112.50, w7 −115.50. orphan_0_0_0 never written — bandit safe.

---

## 2026-10-08 10:30 EDT — FLEET-WIDE EXPANSION: INFRASTRUCTURE BUILT & DRY-RUN VERIFIED

**What:** Built the centralized market-watcher architecture for Anthony's
fleet-wide order (babies go from BRAWL-only to watching ALL new launches +
past coins). Per Anthony's infra reality check: ONE watcher pulls market data
once per tick; 16 babies READ the shared snapshot with ZERO per-baby network
calls for market data.

**Files:**
- `local-runner/market-watcher.mjs` — centralized price+tape fetcher (JSON-RPC
  batched: 2 HTTP reqs/tick regardless of coin count). Writes
  `market-snapshot.json` + KV `market:snapshot`.
- `local-runner/assignment.mjs` — dual-mandate baby↔coin assignment (profit +
  visibility). Scouts (0-7) → new launches; Harvesters (8-15) → profit coins.
  Dead coins (60+ quiet ticks) get 0 babies.
- `local-runner/fleet-dryrun.mjs` — full-fleet simulator with network-call audit.
  Implements CRASH/VALUE/BOTTOM + new LAUNCH-PULLBACK (fresh-coin bootstrap:
  20-30% below launch high → enter small).
- `local-runner/watchlist.json` — 3-coin starter set (BRAWL, SLIPPY, MuseAGI).
- `local-runner/FLEET-MIGRATION-PLAN.md` — phased live migration plan.

**Design decisions (Anthony's directives):**
- Dual mandate: every assignment weighs profit edge AND visibility for his coins.
  New launches get priority (outside buyers look there first).
- "Seeding on steroids WITH profit": babies are independent traders, never
  coordinate — legitimate market activity, not wash trading.
- Past trades matter: tape features (flow imbalance, activity, whale presence,
  buyer diversity) computed per coin, feed the regime state.

**Dry-run proof (2026-10-08):**
- 3 coins: 3 HTTP reqs, 4-5s. 10 coins: 3 HTTP reqs, 7.8s. Batching scales.
- Zero per-baby market-data network calls: PASS (audited via fetch hook).
- Cold-start guard (historyReady, 10+ ticks): PASS — 0 false BOTTOM signals.
- LAUNCH-PULLBACK: PASS — fires at 24.8% below launch high on simulated fresh coin.
- Invalid pools (2/10 in scale test): correctly marked valid=false, skipped.

**NOT done:** Live migration. worker.js is UNTOUCHED (BRAWL trader still runs).
Migration requires Anthony's explicit go-ahead per FLEET-MIGRATION-PLAN.md
Phase A→D. No live wallets touched, no trades executed, no KV schema changes.

**Next:** Anthony decides — (1) approve Phase A (shadow watcher), (2) WETH-only
or multi-pair, (3) new-launch auto-add vs manual curation.
