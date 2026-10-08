# Fleet-Wide Baby Trader: Migration Plan (BRAWL-only → Multi-coin)

## Status: INFRASTRUCTURE BUILT & DRY-RUN VERIFIED. Live migration NOT started.

## What was built (2026-10-08)

### 1. Centralized Market Watcher (`local-runner/market-watcher.mjs`)
- Pulls price + swap tape for ALL watched coins ONCE per tick via JSON-RPC batching.
- **2 HTTP requests per tick total** (1 for prices, 1 for logs) regardless of coin count.
- Writes shared snapshot to `market-snapshot.json` + KV `market:snapshot`.
- Per-coin: price, 1h high, 24h low, buckets, tape (buy/sell vol, counts, whales,
  unique buyers), dip metrics, dead/quiet tracking, launch-high tracking.
- **Cold-start guard**: `historyReady` flag (10+ ticks) gates VALUE/BOTTOM signals —
  prevents "everything is at the 24h low" false buys on first tick.
- Invalid pools (non-standard config) marked `valid=false`, skipped by assignment.

### 2. Baby↔Coin Assignment (`local-runner/assignment.mjs`)
- Dual mandate scoring: visibility (new launches + priority) + profit edge (volume, volatility).
- Specialist/generalist split: babies 0-7 = SCOUTS (new launches), 8-15 = HARVESTERS (profit).
- Each baby watches up to 3 coins. Dead coins (60+ quiet ticks) get 0 babies.
- Recomputed from snapshot; deterministic.

### 3. Fleet Dry-Run (`local-runner/fleet-dryrun.mjs`)
- Simulates all 16 babies × assigned coins using snapshot ONLY.
- **Network audit**: fails if babies make ANY market-data network calls (must be 0).
- Implements 4 buy signals: CRASH, VALUE, BOTTOM, LAUNCH-PULLBACK (fresh-coin bootstrap).
- Tape features computed: flow imbalance, activity level, whale presence, buyer diversity.

### 4. Watchlist (`local-runner/watchlist.json`)
- Starts with 3 coins: BRAWL (baseline), SLIPPY (high priority), MuseAGI (medium).
- Scale up only after per-tick load verified.

## Dry-run results (2026-10-08)

| Scale | HTTP reqs | Latency | Valid pools | Notes |
|-------|-----------|---------|-------------|-------|
| 3 coins | 3 | 4-5s | 3/3 | All valid, all quiet (0 swaps/10min) |
| 10 coins | 3 | 7.8s | 8/10 | 2 invalid pools correctly skipped; 1 coin had 2 buys |

- **Zero per-baby market-data network calls**: PASS (audited).
- **Cold-start guard**: PASS (0 false BOTTOM signals on tick 2).
- **LAUNCH-PULLBACK**: PASS (fires at 24.8% below launch high on simulated fresh coin).
- **Batching scales**: 7 extra coins cost only +2.4s, +0 HTTP requests.

## Migration steps (LIVE — requires Anthony's explicit go-ahead)

### Phase A: Parallel shadow mode (1-2 days)
1. Add `market-watcher.mjs` to cron (every minute, before the baby tick).
2. Babies CONTINUE trading BRAWL via existing worker.js (untouched).
3. Watcher builds snapshot + history for the 3-coin set. No baby behavior changes.
4. Verify: snapshot latency <10s, KV writes succeed, history accumulates.

### Phase B: Worker parameterization (code change — Wren-side review only)
1. Refactor worker.js: add `ctx.coin = {address, poolId, name}`.
2. Replace `BRAWL` constant refs in executeBuy/executeSell/processWallet with `ctx.coin.address`.
3. Namespace KV: `price:tick` → `coin:{addr}:price:tick`, etc.
4. Positions: `wallet:{i}:position` → `wallet:{i}:pos:{addr}` (one per coin).
5. Q-tables STAY per-wallet (`wallet:{i}:qtable`) — general skill, not coin-specific.
6. NN: extend buildFeatures with tape inputs (F[46+]: flow imbalance, activity, whale, diversity).
7. **QGRID_VER NOT bumped** — existing Q-values carry over.

### Phase C: Gradual rollout
1. Enable 1 baby on SLIPPY (in addition to BRAWL). Verify: trades execute, Q updates, no errors.
2. Expand to 4 babies × 2 coins. Verify herd protection (cooldowns + NN veto prevent synchronized buys).
3. Full fleet × 3 coins. Monitor egress load.
4. Scale watchlist to 5-10 coins only if latency holds.

### Phase D: New-launch integration
1. Watchlist auto-adds new launches (from coin registry, deploy_date < 7d).
2. LAUNCH-PULLBACK signal goes live for fresh coins.
3. Dead-coin rotation activates (60 quiet ticks → 0 babies → slot freed).

## Safety rails (carried over + new)
- 0.0002 ETH reserve untouched (per-wallet GAS_RESERVE_WEI).
- Data-quality blind gate applies per-coin (skip coin if its snapshot is stale).
- No wash trading: babies never coordinate; assignment is independent per baby.
- Max 4 babies buy same coin per tick (herd protection — NEW).
- Cold-start: no VALUE/BOTTOM signals until 10+ ticks of history.
- All existing worker.js safety (receipt fallback, orphan reconciliation, abort controller) preserved.

## Open questions for Anthony
1. Should babies trade non-WETH pairs (ZORA, USDC)? Price math differs — start WETH-only?
2. Max coins per baby: 3 is the design — OK or want more/fewer?
3. New-launch auto-add: from registry, or manual curation?
