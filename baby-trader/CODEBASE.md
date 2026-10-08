# CODEBASE: how this bot is put together, and how to change it without breaking it

**Read this before editing anything.** For running and fixing the bot, see `RUN-IT.md`. For *why* things are the way they are, see `WREN-GUIDE.md` and `CLOUDFLARE-NOTES.md`. Sources are in `REFERENCES.md`.

## 1. The three safety nets (use them every time)

| Command | What it proves | When |
|---|---|---|
| `npm test` | 38 tests, ~6 s, **no network, no money**. Includes the **golden master**: 12 scripted market situations whose every transaction, every stored value and every log line must match `test/golden/recording.json` byte for byte. Changing the hard stop from 40 to 41 fails it. | After **every** edit |
| `npm run test:workerd` | Runs the real bot inside **Cloudflare's own runtime** (workerd), with the Durable Object, alarm loop, status, pause/resume and ops tools, against a fake chain. Offline-safe, ~40 s. | Before every deploy |
| `npm run status -- --remote` | The live bot is healthy. One HTTPS call to the worker, **zero RPC from your PC**. | Daily, and after every deploy |

**If the golden test fails, you changed behavior.** If that was on purpose, re-record with `node test/golden/record.mjs` and **read `git diff test/golden/recording.json` line by line**. Every changed transaction or value in that diff is something the live bot will now do differently. If you can't explain a line, don't commit it.

## 2. Where everything lives

```
cloudflare.js        Cloudflare entry (wrangler main). Exports ONLY handlers + TraderDO.
worker.js            Entry for Node/tests/scripts: handlers, mode switch, helper exports.
src/
  config.js          ALL constants, addresses, ABIs, tunables. Change numbers HERE only.
  qtable.js          Seeded RNG, combo keys, Q-table shape + migrations.  [format: don't touch]
  bandit.js          Epsilon-greedy combo choice (the "Q-learning" is a bandit).
  nn.js              The small neural net (advisory until 100 trained closes).
  features.js        The 48 NN inputs. Units: sq is LINEAR in price.
  market.js          Price math, 24h low, swap flow, spike attribution, depth, TWAP.
  ethusd.js          ETH/USD (median of 3 APIs, Chainlink fallback).
  execution.js       $$ Quotes, Permit2 signatures, sending txs, receipts, approvals.
  buy.js             $$ executeBuy: write-ahead record -> broadcast -> position record.
  sell.js            $$ executeSell: gas bar, spike own-target gate -> broadcast -> P&L.
  close.js           recordClose: reward, Q-update, NN training, stats.
  attribution.js     Which combo gets credit for an orphaned position.
  wallet.js          processWallet: one baby's decision per tick.
  tick.js            runTick: the whole tick (gates, shared senses, spike pass, wallets).
  shaping.js         Points-only bonuses/penalties. NEVER feed these into Q.
  fleet.js           Fleet stats per tick.        patterns.js  Pump/dump memory, leaderboard.
  kv.js              kvGet / kvPut / kvPutCritical + raceTimeout. ALL state goes through these.
  handlers.js        One logged tick (shared by cron, POST /tick, the Durable Object).
  durable.js         TraderDO: alarm loop, kill switch, health, backup/restore.
local-runner/        Fallback: run on a PC (loop.mjs, run-tick.mjs), doctor.mjs, ops.mjs, watcher.
sim/                 Simulators and training (no network except fetch-real.mjs).
test/                Everything above, proven. test/golden = the behavior lock.
```

**$$ = money path.** Changes there need: `npm test` green, an intentional golden re-record with the diff read, `npm run test:workerd` green, then a day of `DRY_RUN=true` live before real trades.

## 3. What one tick does (in order)

1. `durable.js` alarm (or the legacy cron) → `handlers.runLoggedTick` → `tick.runTick`.
2. **Price:** read the pool price (`market.fetchPoolSq`). No price → `SAFE-ABORT`, no trades.
3. **Safety gates:** circuit breaker (>20% move in a minute = 5 min halt); quiet tick (<0.5% move and nobody holding = history update only).
4. **Shared senses, once per tick:** ETH/USD, 1h high, 24h low (`rollLow24`), buckets, gas, TWAP, swap flow, depth, data quality, fleet stats.
5. **Spike pass**, if the price is up ≥10% this tick:
   - attribute the spike (`isOwnerDrivenSpike`);
   - owner/fleet-driven → **hold**, including the profit exits in step 7;
   - otherwise up to 4 sells, best first, each only at its OWN target.
6. **Max-hold pick:** at most one orphan exit per tick.
7. **Each wallet**, 4 at a time (`wallet.processWallet`):
   - **holding:** target → NN early exit (once trusted) → hard stop (−40%) → per-wallet stop-loss → max-hold → hold;
   - **flat:** cooldown → bandit picks a combo → CRASH / VALUE / BOTTOM signal → NN advisory → `executeBuy`.
8. **Points-only post-pass** (`shaping.js`), then the leaderboard.

## 4. Stored state (Workers KV in legacy mode, Durable Object storage in Cloudflare mode, `kv-store.json` locally)

All values are JSON strings, read and written only through `src/kv.js`. **The money-critical keys are in bold.** Locally they reach disk before `put()` returns (`local-runner/kv-local.mjs`).

| Key | Written by | Read by | What |
|---|---|---|---|
| **`wallet:{i}:position`** | buy.js, sell.js, wallet.js | wallet, tick, fleet, shaping, durable | Open position (cost basis, amount, combo, buy time). `null` = flat. |
| **`wallet:{i}:pendingBuy`** | buy.js (before broadcast), wallet.js | wallet.js | Write-ahead record: the true combo if the position write is lost. |
| **`wallet:{i}:lastTrade`** | buy.js, sell.js | wallet.js | Cooldown clock. |
| `wallet:{i}:qtable` | close.js, wallet.js | close, wallet | 432 combo values + `baseline_unattributed`. **Format is fixed.** |
| `wallet:{i}:qgridver` | wallet.js | wallet.js | Grid version; a mismatch resets the Q-table. |
| `wallet:{i}:stats` | close, buy, shaping, wallet | many | Trades, wins, P&L, points, streak, `pnlHistory`. |
| `wallet:{i}:seed` / `:rng` | wallet.js | wallet, close | Per-wallet seeded params and RNG state (reproducible exploration). |
| `wallet:{i}:lastSell` / `:pendingSell` / `:lastCashDrag` | sell, buy, shaping | buy, shaping, wallet | Swing bonus, delayed sell scoring, cash-drag cooldown (points only). |
| `nn:weights:brawl:{i}` / `nn:pending:{i}` / `nn:sellfeat:{i}` | nn, wallet, close | nn, close | NN weights (with `nTrained`) and the feature snapshots it trains on. |
| `price:tick` / `price:tickPrev` / `price:high1h` / `price:low24h` / `price:buckets` | tick.js | tick, wallet | Price history (`sq` = price × 2¹⁹², linear). |
| `circuit:tripped` | tick.js | tick.js | Circuit-breaker halt until a set time. |
| `ethusd:last` / `:prev1h` / `:snapTs`, `gas:last` | ethusd, tick | ethusd, tick | Caches for shared senses. |
| `fleet:buyLog` / `fleet:sellLog` | buy, close | fleet, shaping, sell | Last 15 min of fleet trades. |
| `arena:recentRewards` / `:avgReward` / `:lastTournament` | close, shaping | wallet, shaping | Adaptive epsilon, daily tournament. |
| `maxhold:exitWallet` / `:exitTick` | tick.js | wallet.js | The one orphan allowed to max-hold-exit this tick. |
| `pattern`, `leaderboard`, `meta:lastBoardLog` | patterns.js | patterns, durable | Swing memory, board. |
| `meta:tickLock` | tick.js | tick.js | 45 s timestamp lock. **So the tick interval must be > 45 s.** |
| `meta:lastTickLog` | handlers.js | GET /log | Last tick's log (150 lines). |
| `meta:heartbeat` / `meta:recentLog` / `meta:paused` | durable.js | /health, doctor | Cloudflare mode only: liveness, rolling log, kill switch. |

## 5. Rules (each one exists because breaking it already cost money or learning)

1. **Units.** `sq = sqrtPriceX96²` is LINEAR in price. Never `sqrt()` it, never `0.5*log()` it.
2. **Uniswap V4 swap signs are the TRADER's.** In a Swap event, `amount > 0` means the trader *received* that currency. This is the opposite of V3. Verified on real Base transactions in `test/fixtures/v4-swaps.json`. Three places had it backwards.
3. **Credit the arm that fired.** The Q-update key is the bandit's grid key (`position.comboKey`), never something rebuilt from sizes.
4. **Shaped points never reach Q, win rate, tilt or drawdown.** Only real P&L does.
5. **Unknown ≠ zero.** A failed balance or quote read means *hold this tick*, never "the wallet is empty".
6. **Never invent attribution.** If you don't know which combo fired, credit `baseline_unattributed`.
7. **Every `setTimeout` race is cleared.** Use `raceTimeout()` (`src/kv.js`); a bare `Promise.race` leaks timers.
8. **Money-critical writes go through `kvPutCritical`** and come before anything optional.
9. **A tick never overlaps a tick.** Cloudflare: the Durable Object alarm guarantees it. Local: the lock file guarantees it. Don't add a second scheduler.
10. **`cloudflare.js` exports only handlers.** Cloudflare's runtime refuses to start if the main module exports a string or array.
11. **Never trade the fleet against itself on a public pool.** Fleet-vs-fleet belongs in `sim/` or on a fork.
12. **Don't tune thresholds, grids or the bandit to "make it trade".** The sim showed the current strategy family has no out-of-sample edge (`WREN-GUIDE.md` §9). Strategy changes must pass `node sim/train.mjs` with `EDGE` on held-out pools first.

## 6. Change checklist (copy into your notes for every change)

- [ ] Which module? Is it **$$**?
- [ ] Constants only in `src/config.js`. No new `let` at module top level; if you need a runtime override, add a setter there.
- [ ] `node --check` on every changed file; `npm test` green.
- [ ] Golden: green, or intentionally re-recorded with **every diff line explained**.
- [ ] New behavior has its own test (use `test/helpers/fake-chain.mjs`, which runs real ticks on a fake chain).
- [ ] `npm run test:workerd` green before deploying.
- [ ] Deploy with `DRY_RUN = "true"`, watch `npm run status -- --remote` for a day, then go live.
- [ ] Note it in `docs/original/improvement-ledger.md` with the numbers.
