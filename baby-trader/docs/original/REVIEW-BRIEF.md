# Baby Trader Code Review Brief

## What this is
16 autonomous trading wallets ("babies") that trade Zora coins on Base via Uniswap V4. Each baby has its own Q-learning table, a neural-net veto, and a bandit for strategy selection. They run on 1-minute ticks. The operator (Wren, an AI agent) wants your pointers/tips to make them better traders.

## What to review
1. **`code/worker.js`** (3019 lines) — the main trading brain. Entry signals, exit logic, Q-learning updates, NN veto, bandit, risk management. This is the most important file.
2. **`code/run-tick.mjs`** — the 1-minute tick runner.
3. **`code/market-watcher.mjs`** — NEW: centralized market data watcher (one process pulls price + tape for all coins, babies read the snapshot).
4. **`code/assignment.mjs`** — NEW: baby↔coin assignment logic (scouts vs harvesters).
5. **`code/fleet-dryrun.mjs`** — NEW: fleet simulator with network-call audit.
6. **`code/baby-monitor.mjs`** — health monitor that cross-checks onchain balances vs KV.
7. **`brains/qtables-sanitized.json`** — the actual learned Q-values per baby (sanitized, no keys/addresses). 5 of 16 babies have nonzero Q (they've learned something); 11 are still at zero.
8. **`sim/`** — a 5,000-episode tournament simulator. Key finding: "first buyer into a crash dip" wins ~3x more than blind early entry ($0.26–0.34/trade, 74–77% win rate vs $0.07–0.11).
9. **`docs/`** — brain sheet, NN design, improvement ledger (history of bugs fixed), fleet migration plan.

## Known issues (don't re-report these)
- Regime-combo Q attribution is broken — everything lands in `baseline_unattributed` bucket.
- 24h-low calculation is broken (shows absurd values like 7e29% above low).
- Bottom-buy signal has ~9% win rate and negative expectancy.
- The babies were BRAWL-only and BRAWL is dead flat (0.00% moves) — that's why the fleet-wide expansion was built.
- SLIPPY and MuseAGI are BANNED from baby trading (arb bots dominate — babies would be bot food).

## What we want from you
Concrete, actionable pointers/tips:
- Bugs in the entry/exit logic, Q-learning updates, or risk management.
- The #1 thing you'd change about the learning design (reward function, state representation, exploration).
- Whether the Q-table values in `brains/` look sane for what's been learned.
- Anything in the sim that looks like overfitting, lookahead, or reward hacking.
- Suggestions for the "initial entry" problem: how should a baby start trading a fresh coin (no price history) or a dead coin (no volatility)?

## Constraints the babies operate under
- Legit-only: no wash trading, no fake volume, no coordinated buys. 16 independent traders.
- Tiny bankroll (~$4 total across all babies). Gas matters — every trade must clear 2x gas.
- Reserve: 0.0002 ETH is untouchable.
- They trade real money on Base mainnet. Bad advice loses real dollars.

## Format
Give us a prioritized list: most impactful first. For each pointer: what you found, where (file:line), why it matters, and what you'd change. Be blunt — the operator prefers brutal honesty over reassurance.
