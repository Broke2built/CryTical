# SLIPPY Trader — Neural Network Design (v1)

**Date:** 2026-10-07 14:29 EDT
**Author:** Wren (subagent build)
**Status:** v1 — MLP scoring layer on top of the RL bandit. Incremental path to full NN trader.

## Why

The Q-learning bandit learns discrete threshold combos (108 cells: dump × value × margin × size).
It works, but it can't learn non-linear interactions like:
*"whale dump + low gas + 3am + thin holder base = strong buy, size up"*

A small MLP learns these joint patterns from the full feature vector. Anthony's directive
2026-10-07 14:28: *"it needs a bigger hidden layer and in/out layers too... just keep
improving it and testing it till we have the perfect trader."*

## Architecture (v1)

```
Input (33) → Dense(24, ReLU) → Dense(16, ReLU) → Dense(3, Sigmoid)
              ~816 params        ~400 params       ~51 params
              Total: ~1,267 parameters (~10KB JSON in KV)
```

- **Pure JS, zero dependencies.** Hand-rolled forward + backprop (~120 lines).
- **Inference:** ~1,200 multiply-adds → <1ms. Well under the 100ms budget.
- **Per-wallet independent:** each of the 16 burners has its OWN weight copy in KV
  (`nn:weights:{i}`). They learn independently and compete — same as the bandit.
  (Shared-base + per-wallet fine-tune is a v2 optimization.)

## Input layer — 38 features (all normalized)

### Price multi-timeframe (12)
| # | Feature | Normalization |
|---|---------|---------------|
| 1 | ret_5m — log return, last 5 min | `tanh(ret*10)` → [-1,1] |
| 2 | ret_15m | `tanh(ret*10)` |
| 3 | ret_1h | `tanh(ret*10)` |
| 4 | ret_4h | `tanh(ret*10)` |
| 5 | ret_24h | `tanh(ret*10)` |
| 6 | vol_5m — stdev of 1-min log returns, 5m window | `min(1, vol*20)` → [0,1] |
| 7 | vol_1h | `min(1, vol*20)` |
| 8 | dip_1h — % below 1h high | `/100`, clip [0,1] |
| 9 | above_low_24h — % above 24h low | `min(1, x/200)` → [0,1] |
| 10 | tick_move — last tick % move (signed) | `tanh(x/5)` → [-1,1] |
| 11 | accel — tick_move minus previous tick_move | `tanh(x/5)` → [-1,1] |
| 12 | range_pos — (price-low24)/(high1h-low24) | clip [0,1] |

Source: `price:buckets` KV key — rolling array of `{ts, sq}` (last 300 ticks ≈ 5h).
Computed on the fly per tick; no extra RPC calls.

### Pattern regime (6)
| # | Feature | Normalization |
|---|---------|---------------|
| 13 | avg_pump_pct (rolling) | `min(1, x/100)` |
| 14 | avg_dump_pct (rolling) | `min(1, x/100)` |
| 15 | avg_cycle_min (rolling) | `min(1, log10(1+x)/3)` |
| 16 | regime_pump — last extreme was a top (currently falling) | 0/1 |
| 17 | regime_dump — last extreme was a bottom (currently rising) | 0/1 |
| 18 | swing_count_1h — # of >5% swings in last hour | `min(1, x/10)` |

Source: existing `pattern` KV object (already tracked by `updatePatterns`).

### Wallet state (6)
| # | Feature | Normalization |
|---|---------|---------------|
| 19 | eth_balance | `min(1, log10(1+eth)/2)` (0.01 ETH → ~0.5) |
| 20 | slippy_balance | `min(1, log10(1+tokens)/7)` |
| 21 | position_pnl_pct — unrealized P&L % (0 if flat) | `tanh(x/50)` → [-1,1] |
| 22 | position_age_min | `min(1, x/1440)` (0 if flat) |
| 23 | is_holding | 0/1 |
| 24 | wallet_points — cumulative RL points | `tanh(x/500)` → [-1,1] |

### Market (4)
| # | Feature | Normalization |
|---|---------|---------------|
| 25 | gas_price | `min(1, log10(1+gwei)/2)` |
| 26 | eth_usd_ret_1h | `tanh(ret*50)` → [-1,1] |
| 27 | hour_sin | `sin(2π·hour/24)` → [-1,1] |
| 28 | hour_cos | `cos(2π·hour/24)` → [-1,1] |

### Fleet opponent-awareness (4) — arena upgrade 2026-10-07 22:00 EDT
| # | Feature | Formula |
|---|---------|---------|
| 29 | fleet_crowdedness | `holdingCount / 16` → [0,1] — fraction of fleet currently holding |
| 30 | fleet_avg_roi | `tanh(avgPnlPct / 50)` → [-1,1] — is the arena winning overall? |
| 31 | own_vs_fleet | `tanh((ownPnl - fleetAvgPnl) * 200)` → [-1,1] — am I beating the competition? |
| 32 | fleet_sell_pressure | `clip01(recentSells10m / 8)` → [0,1] — fleet sells in last 10 min |

### Regret (1) — superintelligence upgrade 2026-10-07 23:05 EDT
| # | Feature | Formula |
|---|---------|---------|
| 33 | max_regret | `clip01(sqrt(peakSq/entrySq) - sqrt(nowSq/entrySq))` → [0,1] — (peak price − current price) / entry price. Held through a 20% peak-to-trough → ~0.20. The NN learns: high regret = should have sold. |

### PLUS ULTRA senses (5) — 2026-10-07 23:07 EDT (Anthony: "superhuman eyes and ears")
| # | Feature | Formula |
|---|---------|---------|
| 34 | volume_ratio | `buyVol/(buyVol+sellVol)` → [0,1], 0.5 neutral — BRAWL buy vs sell volume, last ~10 min, from PoolManager Swap events (address-only getLogs, client-side pool filter). Buys >> sells → momentum up. |
| 35 | market_impact | `clip01(positionWeth / depth2pctWeth)` → [0,1] — my position as fraction of the WETH that moves price 2% (depth ≈ L·0.01·√P from StateView.getLiquidity). 1.0 = full exit eats ~2% slippage. w0 watches this. |
| 36 | gas_spike | `tanh((gwei - lastTickGwei)/5)` → [-1,1] — gas momentum. Spiking gas → re-time the exit; the 1.5x profit gate is gas-sensitive. 0 = stable. |
| 37 | whale_flow | `tanh(whaleNetBrawl / 10M)` → [-1,1] — net BRAWL flow from swaps moving >1M BRAWL, last ~10 min. + = whales net buying. NN already sees fleet flow (F[29-32]); this lets it learn fleet-vs-external. |
| 38 | price_velocity | `clip01(annVol / 10)` → [0,1] — annualized volatility from 1-min log returns (last 60 min). 1000% ann vol → 1.0. Fast = opportunity or danger. |

1-indexed above; 0-indexed in code these are F[33]–F[37].

### Swing-cycle (1) — 2026-10-07 23:37 EDT (Anthony: "teach them to buy back in")
| # | Feature | Formula |
|---|---------|---------|
| 39 | time_since_sell | `clip01((now - lastSell.ts) / 24h)` → [0,1] — 0 = just sold (within 5 min, re-entry window open), 1 = sold >24h ago or never sold. Helps the NN learn: "I just sold — buy the dip back now or wait?" Pairs with the swing bonus (sold $100, rebought $90 = +100pts) and cash-drag penalty (flat during +5% 1h rally = −50pts/15min). |

0-indexed in code this is F[38]. (NN grew to 45 inputs with F[44]; see live holding-bleed section below.) All senses are fail-soft: RPC failure →
neutral fallback, senses never break the tick.

### Trader-needs audit (5) — 2026-10-07 23:41 EDT (Anthony: "do it")
What a real trader knows that the babies couldn't see: regime, levels, self.
| # | Feature | Formula |
|---|---------|---------|
| 40 | trend_efficiency | Kaufman Efficiency Ratio over 30 one-min buckets: `\|P_now − P_30m_ago\| / Σ\|P_t − P_{t−1}\|` → [0,1]. 0 = pure chop (every move reverses), 1 = straight trend. The #1 trader question: trending → buy dips; ranging → fade extremes. Fail-soft 0.5 (neutral) on <10 buckets. |
| 41 | level_pressure | `tanh((touches_high − touches_low) / 4)` → [-1,1] — touches of 1h high / 24h low in last 4h (touch = bucket close within 0.5% of level). +1 = pressing resistance (breakout brewing), −1 = hammering support (breakdown brewing). Traders trade levels, not returns. Fail-soft 0. |
| 42 | win_rate | `(wins_last20 / 20 − 0.5) * 2` → [-1,1] — +1 = hot (20/20), −1 = ice cold. Lets the NN learn Kelly-style sizing: big when proven, small when cold. Fail-soft 0 for fresh wallets. |
| 43 | tilt | `tanh(consecutive_losses / 3)` → [0,1) — 0 = no tilt, →1 = deep tilt (5+ straight losses). After repeated losses the policy is likely miscalibrated; size should shrink until edge re-proves. Tracked as `streak` in wallet stats. Fail-soft 0. |
| 44 | drawdown | `(peakPoints − points) / peakPoints` → [0,1] — 0 = at all-time high, →1 = deep hole. Capital preservation mode: deep drawdown → fewer chances, tighter exits. Tracked as `peakPoints` (high-water mark) in wallet stats. Fail-soft 0. |

1-indexed above; 0-indexed in code these are F[39]–F[43]. Stats bookkeeping: `recordClose` now writes `streak` (reset on win, increment on loss) and `peakPoints` (running max of points) into `wallet:{i}:stats`.

### Live holding-bleed (1) — 2026-10-08 00:04 EDT (Anthony: "yea we need to improve that line of thinking...")
The holding tax (10pts/15min while |ROI| < 1%) was charged only at `recordClose()` — babies accrued a bill but felt no pain while holding. F[44] exposes the liability LIVE.
| # | Feature | Formula |
|---|---------|---------|
| 45 | holding_bleed | `clip01(accruedPts / 100)` → [0,1] — accrued = `floor(holdMinutes / 15) * 10`, only while `|unrealizedPnlPct| < 1%`. 0 = fresh or winning (no bleed), →1 = 100+ pts bleeding (deep standoff). The tax is still deducted at close (accounting); this is the live signal so the NN learns to sell to stop the bleed. Fail-soft 0 (no position). |

0-indexed in code this is F[44]. NN is now 45→24→16→3 (NN_VER=6, QGRID_VER=10). All senses are fail-soft: RPC failure → neutral fallback, senses never break the tick.

### Infrastructure (not NN inputs)
- **EYES #1** — price already comes from `StateView.getSlot0(poolId)` onchain (sub-second, no HTTP). Unchanged.
- **EYES #2** — 10-min TWAP from bucket history; value-buy signal now requires spot ≤ 1.02× TWAP (don't chase above average).
- **ETH/USD #9** — median-of-3: coinbase/coingecko/kraken queried in parallel, median taken, sources >2% from median rejected (need ≥2 agreeing); then binance → Chainlink onchain → 10-min stale cache → UNKNOWN.
- **Circuit breaker #10** — tick-to-tick move >20% trips a 5-min all-trading halt (price history still updates). Ruthless, not reckless.
- **EARS #7** (mempool snipe detector) — deferred: no mempool API wired; slot reserved.

Repurposed from the v1-neutral holder slots (which were always 0.5). In the AI arena,
each baby sees the competition's posture: crowdedness signals crowded trades,
relative P&L drives competitive behavior, sell pressure warns of fleet exits.
Neutral fallbacks (0.5) preserved when fleet data is unavailable.

## Output layer — 3 neurons (sigmoid → [0,1])

| Output | Meaning | Mapping |
|--------|---------|---------|
| buyScore | Confidence this tick is a good buy | 0-1 (gate: buy only if > 0.35) |
| buySize | % of available balance to spend | 0-1 → 10% + 0.9·x → [10%, 100%] |
| sellScore | Confidence this tick is a good sell | 0-1 (early-exit trigger if > 0.70) |

## Integration with the bandit (v1 — advisory, not replacement)

The bandit keeps working. The NN **augments** it:

1. **Buy path:** bandit fires a buy signal (crash/value/bottom) → NN scores the
   feature vector → if `buyScore < 0.35`, VETO the buy (log the veto).
   If buy proceeds, `buySize` from NN overrides the bandit's discrete size grid
   (continuous > discrete).
2. **Sell path:** if holding and `sellScore > 0.70` AND profit clears the 1.5× gas
   bar, sell immediately (NN can trigger exits the bandit's fixed rules miss).
3. **Exploration:** bandit's epsilon-greedy still explores; NN learns from all outcomes.

As the NN proves itself (higher win rate than bandit-only decisions), v2 dials up
NN authority → v3 replaces the bandit entirely.

## Training — online backprop

- **Init:** Xavier uniform, per-wallet, stored in KV (`nn:weights:{i}`).
- **On buy:** snapshot the 33-feature vector → `nn:pending:{i}`.
- **On sell (trade complete):** compute reward (same scale as bandit: 1pt/profit-cent).
  Backprop one SGD step (lr = 0.01):
  - Buy outcome: target `buyScore` = 1 if profit ≥ bar, 0.3 if small profit, 0 if loss.
    Target `buySize` = actual size used (reinforce what worked).
  - Sell outcome: target `sellScore` = 1 if profit ≥ bar, 0.5 if breakeven-ish, 0 if loss.
  - Only the relevant outputs get gradient; others are masked (no spurious updates).
- **No catastrophic forgetting:** lr=0.01 is conservative; 1,243 params on a slow
  drip of trades won't thrash.

## Transfer learning (v2+)

- Weights stored per-coin: `nn:weights:{coin}:{i}`.
- New coin → initialize from the best SLIPPY wallet's weights (the "alpha"),
  then fine-tune online. Generalized patterns (whale-dump→buy) transfer;
  coin-specific calibration (volatility scale) adapts within ~20 trades.
- v1 stores under `nn:weights:slippy:{i}` to make this path clean.

## KV keys (new)

| Key | Content |
|-----|---------|
| `price:buckets` | `[{ts, sq}]` last 300 ticks |
| `nn:weights:slippy:{i}` | `{w1:[],b1:[],w2:[],b2:[],w3:[],b3:[],ver:1}` |
| `nn:pending:{i}` | `{features:[33], buySizePct, buyTs}` — set on buy, consumed on sell |

## Backtest plan

No long price history exists in KV yet (bot is days old). v1 ships in **shadow mode**
for 24h:
- NN scores every tick, logs buyScore/buySize/sellScore
- Bandit still makes all decisions
- Compare: would NN-vetoed buys have lost? Would NN-triggered sells have won?
- If NN precision > bandit baseline → promote to advisory (v1.1) → full (v2)

## File changes (v1)

- `worker.js`: +NN section (~200 lines: MLP, features, integration, backprop)
- `NN-DESIGN.md`: this file
- `wrangler.toml`: no change (KV binding already exists)
- `README.md`: changelog entry

## Open questions for v2

1. Holder snapshot wiring (which api-sdk endpoint is cheapest?).
2. Shared base weights + per-wallet delta (cuts KV writes 16×).
3. Deeper net (33→32→24→16→3) if v1 underfits.
4. Recurrent layer (LSTM cell) for sequence memory — only if MLP plateaus.
