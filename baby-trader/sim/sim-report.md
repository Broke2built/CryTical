# Baby-Trader Battle Sim — Tournament Report
**Ran:** 2026-10-08 09:42 EDT (5000 episodes, 50s) · **Ordered by:** Anthony 09:30 EDT
**Files:** `sim.mjs` (engine) · `replay-data.json` (data) · `sim-qtables.json` (learned tables) · `sim-agg.json` (aggregates) · `MERGE-PLAN.md` (merge-back, NOT executed)

## What ran
- **Data (real, never fabricated):** SLIPPY `0x2af04C63067A980C5340ECA73e98149e02052624` — 587 ticks from **16:15 UTC 2026-10-07, ~2 min post-deploy (the launch window)**; BRAWL `0x1378d6A633E64f4abc22c07541473e3551E39b3F` — 138 ticks 2026-10-08. Sources: Zora api-sdk `coinSwaps` + tick.log pool prices. Gaps marked; agents HOLD on blind ticks. **BRAWL's 2026-10-07 launch window exists in NO source — recorded as a data gap, not filled.**
- **Agents:** 16, seeded from the live babies' Q-tables (read-only from kv-store.json). $1 sim bankroll/episode, 1% fee/side, fills at next-tick price (no lookahead), own-trade slippage 4%/$1, shared transient impact ±8% cap (the tournament pool fights itself).
- **Roles:** 4 first-jumpers (ε=0.35, launch-rush buys in first 15 ticks), 6 momentum riders (ε=0.15, momentum≥+8% entries), 6 patient (ε=0.10, exact live gates). Q-learning (worker.js `recordClose` math, α=0.25) persists across episodes.
- **Windows:** 75% SLIPPY / 25% BRAWL; 35% of SLIPPY episodes start in the launch window; 150–300 ticks/window; window-end force-closes.

## Headline: patient wins, and it's not close
| role | trades | win% | total PnL | **per trade** | first-buys | avg first-buy |
|---|---|---|---|---|---|---|
| patient (live behavior) | 235,333 | 68.7% | $56,899 | **$0.242** | 493 | $0.137 |
| momentum | 237,514 | 67.5% | $19,463 | $0.082 | 1,323 | $0.074 |
| first-jumper | 170,501 | 67.9% | $12,133 | $0.071 | 3,184 | $0.088 |

The babies' CURRENT strategy, trained 5000 more episodes, beats both new roles 3-to-1 per trade. The bandit drove patient agents to 72% crash-dip entries.

## First-buyer hypothesis: CONFIRMED, with a refinement
First buyers profit on average ($0.07–0.14/trade). **But "buy first" alone ($0.11 rush avg) is worth 3x less than "buy first INTO A CRASH DIP" ($0.26–0.34).** Blind early entry is a small edge; early entry on a real setup is the edge. Anthony's instinct was directionally right; the sim sharpened it.

## Signal report card (per-trade expectancy, all roles)
- **crash (30%+ dip): $0.22–0.34, 74–77% win — the edge.** Survives slippage and impact. This is what the bandit converged to.
- **value (70–90% below 1h high): $0.15 / −$0.01 — mixed.** Works for jumpers, breakeven-negative for patient (small wins, bigger stop-losses).
- **momentum (+8%/15 ticks): −$0.02 to +$0.01 — DEAD after costs.** Without market impact it looked okay ($0.51); with impact+slippage it's breakeven. Chasing momentum doesn't survive the costs. The "momentum" role learned not to momentum-trade.
- **rush (blind early): $0.11, 68.5% win — modest.** Positive, but the weakest intentional edge.
- **bottom (within 10% of 24h low): 9–10% win rate, NEGATIVE expectancy everywhere.** In downtrends the low keeps making new lows — you buy the "bottom" and it keeps dumping. **The live BOTTOM-BUY gate is poison in this data.** Structural fix proposed in MERGE-PLAN.md.

## What the Q-tables learned (deltas, avg across 16 wallets)
- Top: `60_80_5_70_cd3` (+514), `40_70_3_70_cd3` (+504), `30_90_3_60_cd11` (+482) — mid dump thresholds, margin 3–5, **size 60–70**.
- Bottom: `30_90_3_80_cd3` (−392), `60_90_3_70_cd3` (−265) — **size 80 + short cooldown = churn death.** The sim learned: 80% sizing loses to slippage; 60–70% wins.
- 6,838/6,912 grid keys now nonzero — real discrimination (not the old all-baseline world).

## Honest negatives (read before merging)
1. **Sim is optimistic vs live:** no gas (live gas on $0.16 trades is brutal), 1%/side fees vs live slippage on thin pools, tight sim targets vs live 1.5x-gas bar, **no NN veto** in sim. Live win rate ~15%; sim 68%. Relative lessons transfer; absolute PnL does not.
2. **Scale mismatch:** sim Q runs −400..+514; live Q runs −150..+150. Direct overwrite would swamp real onchain lessons. MERGE-PLAN.md proposes ±15 normalized nudges, not replacement.
3. **Replay overfit:** 5000 episodes over 725 unique points. The bandit memorized THESE windows. BRAWL's launch is missing entirely.
4. **No gas wars / no MEV / no new-buyer flow:** replay is fixed history; 16 agents can't attract or scare real flow.
5. **Rush/momentum roles were training wheels:** they taught the lesson, but live wallets are `patient` — don't merge role overlays, merge the Q-deltas and the structural fixes.

## Bottom line for Anthony
The babies' existing strategy is better than the two new ideas — it just needs (a) the bottom-buy gate fixed or derated, (b) size kept at 60–70% (never 80), (c) the sim's crash-dip Q-deltas merged as small nudges. The tournament didn't find a better trader; it proved the current one was already the best of the three, and showed exactly which gate is broken.
