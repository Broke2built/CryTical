# Baby Trader: Review, Fixes and Pro Tips for Wren

Written 2026-10-08 after a full read of `worker.js`, the runners, the sims and the live Q-tables.
Everything below was **fixed in code and tested** unless it says otherwise.
In the code, search for `(review)` and `NOTES FOR WREN` to find every change.

```
npm install          # once (viem)
npm test             # 19 tests, ~5s, no network, no money
node sim/tournament.mjs --scenario mixed --generations 20        # babies fight on a simulated pool
node local-runner/fork-tournament.mjs --ticks 90 --outsiders 4 --activity 0.5   # babies fight on a private Base fork (needs foundry's anvil)
```

---

## 0. The hard line (read this before anything else)

The 16 babies have **one owner**. On a public pool, it doesn't matter why they trade each other.
It could be training, a tournament, or "bootstrapping" a dead coin.
To everyone else it is volume that looks like demand and isn't. That is wash trading.
Outside buyers who react to that volume are the ones who lose money.

- **Fleet vs fleet happens in the sim or on a fork.** `sim/tournament.mjs` and `local-runner/fork-tournament.mjs` give you the full "16 babies fight, survival of the fittest, my trades move the price" experience. Nobody outside can see it, and you get far more trades than live.
- **On mainnet, babies trade the market:** external counterparties only.
- **Disabled:** the heartbeat points (paid for trading, to keep a coin "alive") and the FOMO bonus. That bonus paid a baby for selling into a *sibling's* buy, so the same owner was on both sides.
- **Removed:** the "visibility" score in `assignment.mjs`.

The same lesson shows up in the numbers. In the tournament's `dead` scenario (no outsiders), fleet P&L is **exactly minus fees and gas**. Fighting each other is zero-sum before costs. The only profit that exists comes from outsiders.

---

## 1. Bugs found and fixed, most important first

| # | Where | What was wrong | Why it mattered | Fix |
|---|---|---|---|---|
| 1 | `worker.js` buy path (`executeBuy`, `processWallet`) | The NN's continuous size (10–100) rebuilt the combo key, e.g. `30_70_3_47_cd6` | Closes were credited to keys **outside the grid**. The combo that actually fired never learned. | Q-credit uses the bandit's grid key (`creditKey`). The test asserts the table stays at 433 keys. |
| 2 | `recordClose` reward | `roi*10000/(1+holdHours)` applied to losses too | A −30% loss held 10h scored −273, the same loss cut in 30 min scored −2000. **Holding losers was rewarded.** | `closeReward()`: only gains are time-discounted. The sim uses the same function. |
| 3 | `processWallet` cooldown | The cooldown check ran before the holding branch | For 3–20 min after every buy a baby could not evaluate **any** exit, not even its stop-loss | The cooldown now gates buys only |
| 4 | Stop-loss | Only fired after 1.5–4.5h held | A coin down 60% in minute 5 just sat there | `HARD_STOP_PCT = 40` with no time gate. The per-wallet stop stays. |
| 5 | Margin arm (1/3/5%) | Only printed, never used | 1/3 of the 432 arms were duplicates, splitting the data three ways | The exit target is `max(1.5× gas, margin%)`. The sim already did this. |
| 6 | Bottom-buy (known issue: 9% win rate) | The low resets to *now* on every new low, so "0% above low" fired on every down-tick | It bought falling knives by design | `bottomSignal()`: the low must have held 30 min **and** price must have bounced 2–10% off it |
| 7 | 24h low (known issue: 7e29%) | One corrupt stored low stuck for 24h, and expired lows jumped to spot | Absurd `aboveLow` numbers and false BOTTOM signals | `rollLow24()`: discards lows >1000× below spot and rebuilds expired lows from the price buckets |
| 8 | Regime attribution (known issue: everything lands in baseline) | Orphans had no buy record, so a "reconstructed" key was invented. `snapDump(0)=30` and `snapValue(0)=70`. | **Every nonzero Q-value in `brains/` is fabricated.** They credit the 30%/70% cell, which could not have fired. | A write-ahead `pendingBuy` record is written before broadcast, so orphans keep the true key. Reconstruction now credits the baseline when no grid cell could have fired. The `buyBlock`/`origBuyBlock` name mismatch is also fixed. |
| 9 | NN features | Treated `sq` as price² (`0.5*log`, `sqrt`) | Returns, volatility, regret and the swing bonus were all half-size or warped | `sq` is linear in price. Fixed everywhere. |
| 10 | NN authority | A ~1,600-parameter net with about 40 training samples vetoed buys and set size (up to 100% all-in) | That is a random filter with access to the whole bankroll | It is advisory only until `NN_MIN_TRAINED = 100` closes. The size target now actually learns (it used to echo itself). |
| 11 | Win/loss and tilt stats | Judged on shaped points (a −$0.01 trade plus heartbeat counted as a win) | Corrupted the F[41] win-rate and F[42] tilt inputs | Judged on real P&L |
| 12 | Local runner timers | `Promise.race` timeouts never cleared | Each `run-tick.mjs` stayed alive ~2 min after the tick, holding the flock. **The 1-minute fleet ticked every 2–3 minutes.** | `raceTimeout()` clears its timer, and `run-tick.mjs` exits explicitly. The test suite went from 120s to under 1s. |
| 13 | `market-watcher.mjs` | Price inverted for any coin above `0x4200…`. Volume in the wrong token. The same getLogs fetched N times. A "24h" low that covered 1h. Unique buyers counted routers. | On the fleet expansion these would have produced wrong signals on half the coins | Rewritten. Prices are orientation-normalized, volume is in WETH, there is one getLogs call, 1440 buckets are kept, and tx.from splits **external vs fleet** flow. |
| 14 | `assignment.mjs` | All 8 scouts got the same 3 coins and all 8 harvesters the same 3 | 8 babies on one thin pool, firing on the same tick: front-running each other and looking coordinated on-chain | Round-robin deal, at most 4 babies per coin. Coins with no external traders get 0 babies. |

## 2. Not changed, but needs Anthony's call

- **Reserve.** The brief says 0.0002 ETH is untouchable. The code reserves **0.00005**. At ~$0.25 per wallet, 0.0002 means *no baby can ever buy*. Set `GAS_RESERVE_WEI` in env to enforce whichever is real.
- **Gas bar.** The brief says 2× gas, the code says 1.5×. Pick one.
- **Bankroll vs gas.** About 3% gas per tx means a position needs roughly a +10–15% move before it is allowed to sell. This, not missing features, is why babies sit still. Fewer, larger positions would let them trade.
- **Thresholds.** Crash 30–60% and dip 70–90% almost never fire. A 30%+ **one-tick** crash can never be bought, because the 20% circuit breaker halts trading first. The tournament has `--grid tight` (5–20% / 10–30%). In my runs the tight grid traded 3–4× more but lost in the bubble scenario. **Test before changing.** A grid change wipes Q-tables, which costs nothing because they're fabricated anyway (#8).
- **Spike pass.** It tries to sell every holding wallet in the same tick, the synchronized pattern you already banned. If the spike is Anthony buying, the fleet sells into its own owner.

## 3. The #1 learning-design change

**The bandit has too many arms for the data it gets.** 432 arms per wallet and about 3 closes per wallet per day means each arm's average takes years to mean anything. In order:

1. **Factor it.** Learn dump, value, margin, size and cooldown as 5 independent small tables (17 arms total). Each close updates all 5. You get about 25× faster learning.
2. **Pick once, then commit.** Draw a combo after each close and keep it until it trades. Right now a fresh combo is drawn every tick, and the buy fires if *that* combo's gate passes. So exploration over-credits loose thresholds.
3. **Train in the tournament, not live.** One fork or sim run gives more closes than a month live. Merge results as small rank-based nudges (`sim/MERGE-PLAN.md`), never overwrite.
4. **Shared or pooled learning, if you want it to work at all.** Sixteen strangers learning separately is 16× slower. The tournament's survival-of-the-fittest (copying winners' tables over losers') gives you most of the benefit and keeps the competition.

## 4. Are the Q-tables sane?

No, and not because the babies learned wrong things. Every nonzero entry is `baseline_unattributed` or a `30_70_*` cell from orphan re-attribution (#8). **Treat all 16 tables as empty.** A `QGRID_VER` reset loses nothing real.

## 5. The old sim (`sim/sim.mjs`): what to distrust

- **Fixed:** gas was missing, losses were time-discounted, the stop-loss was time-gated, the bottom signal caught falling knives, and paths were hard-coded.
- **Overfitting:** 5,000 episodes over ~725 price points replays the same handful of crash events thousands of times. The sim now prints **unique entry ticks** per signal. If "crash" has 8 unique entries, the "$0.26–0.34 edge" is 8 data points, not 235k trades.
- **The 68% win rate vs 15% live** came mostly from the missing gas and the 1–5% exit targets. Rerun it with the fixes before believing any ranking.
- **No lookahead found.** Signals at tick j fill at j+1, which is correct.

## 6. Fresh coins and dead coins: the initial-entry problem

A baby only profits if someone **else** takes the other side. So the question is never "how do we get it moving". It is "is anyone already here". `fleet-dryrun.mjs` implements this:

- **Fresh coin:** don't rush in. That was the sim's weakest edge, and on a live chart your 16 wallets would *be* the launch. Enter on a **launch pullback**: 20–30% below the launch high, stable, with at least 3 **external** buyers in the last ~10 min. Size it as a probe (25%), one baby per coin per tick, and only if the position is worth more than about 20× gas.
- **Dead coin:** don't trade it. No external swaps means nobody to sell to. Practice on it in the sim or on a fork instead.
- **Cold start:** VALUE and BOTTOM wait for 10+ ticks of history. `firstSeenTs` is when the *watcher* first saw the coin, not when it launched. Use the real launch time.

## 7. Pro tips for Wren

1. **Units first, always.** Write the unit next to every number (`sq`, WETH, coin units, USD, bps, %). Half the bugs above were unit bugs that looked like plausible numbers.
2. **A metric you can't reproduce is a rumor.** Before claiming "14/16 learning" or "edge confirmed", show the count of *real, unique* events behind it.
3. **Never let a fallback invent data.** Orphan reconstruction "helpfully" made up a combo and poisoned every table. When you don't know, write *unknown* or the baseline, and log it loudly.
4. **Shaping rewards go to points, never to Q.** You already did this for Q. Do it for every stat the NN sees too (win rate, tilt, drawdown).
5. **Every timeout must clean up after itself.** Use `raceTimeout()`, never a bare `Promise.race` with `setTimeout`.
6. **Gate authority on evidence.** No model (NN or bandit) gets to veto, size or exit until it has N real samples. Log its opinion until then.
7. **Test the money path end to end without money.** `test/helpers/fake-chain.mjs` runs real ticks against a fake chain, then use the fork, then `DRY_RUN=true` live. Never ship a change to `executeBuy`/`executeSell` that hasn't passed all three.
8. **One position per baby per coin, and no herd.** If two babies would act on the same coin in the same tick, let only one.
9. **Count external flow, never your own.** Your buys are not demand. `tape.external*` is the only interest that matters.
10. **Change one thing at a time,** run the tournament before and after, and keep the result in the improvement ledger with the numbers.

## 8. Things the fork taught us (verified 2026-10-08 on a real Base fork)

- **BRAWL's pool is microscopic.** The whole 2%-depth is about 0.0008 WETH (~$2). A $6 buy moved price ~50%, and $1.50–$10 trades tripped the 20% circuit breaker every few minutes. On a pool this thin, **the babies' own trades are a big share of all price movement.** That's another reason they must not trade each other there: they'd be reading their own footprints as signals.
- **Zora's quote API can't price a fork.** It simulates against mainnet. `fork-tournament.mjs` keeps Zora's calldata layout but prices with Uniswap's V4Quoter **on the fork**. That matched the API to the wei on mainnet state.
- **The minimum-output word is the only sandwich protection on mainnet.** The fork harness sets it to 1. Never copy that trick into `worker.js`.
- **Ticks take ~10–20 s each on a fork** (quotes plus 16 wallets). A 90-tick fight takes about 20–30 min. Leave it running.

## 9. File map

| File | What it is |
|---|---|
| `worker.js` | The trading brain (live). Notes block at the top. |
| `local-runner/run-tick.mjs` | One live tick locally |
| `local-runner/market-watcher.mjs` | Shared market snapshot for all coins (rewritten) |
| `local-runner/assignment.mjs` | Baby↔coin assignment (rewritten) |
| `local-runner/fleet-dryrun.mjs` | Fleet decisions from the snapshot, including the fresh/dead coin rules |
| `local-runner/fork-tournament.mjs` | **New.** 16 babies fight on a private Base fork using the real `worker.js` |
| `sim/tournament.mjs` | **New.** 16 babies fight on a simulated AMM, with generational culling |
| `sim/sim.mjs` | Replay sim (fixed) |
| `test/` | 19 tests, including a fake chain that runs real ticks |
