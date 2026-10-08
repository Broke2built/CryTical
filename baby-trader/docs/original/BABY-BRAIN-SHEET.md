# BRAWL Trader Arena — System Sheet for External Review

## What This Is
16 independent AI traders (burner wallets w0-w15) competing on BRAWL, a memecoin on Base.
- Contract: 0x1378d6A633E64f4abc22c07541473e3551E39b3F
- w0 holds 57M BRAWL (55% of supply) — the whale
- w1-w15 hold 2M-7M each
- They trade via 1-minute ticks, market orders, real gas costs
- Each has an independent brain — they are STRANGERS, not a team. Zero cooperation.

## Brain Architecture
- **Neural Network:** 45 inputs → 24 → 16 → 3 outputs (~1,700 params)
  - Outputs: buy signal, hold signal, sell signal
  - Buy size: 10-100% (continuous, learned)
- **Q-Learning:** Independent Q-table per wallet, epsilon-greedy exploration
- **Training:** Live, on real market data. No simulation. No backtest.

## The 45 Features (Senses)

### Price & Market (F0-F17)
- F0-F4: Multi-timeframe returns (1min, 5min, 15min, 1hr, 24hr)
- F5-F6: Volatility (short, long)
- F7-F8: Dip detection, position in range
- F9-F10: Tick momentum
- F11: Price vs VWAP
- F12-F17: Pump/dump pattern statistics
- F37: Price velocity (annualized)

### Volume & Flow (F33, F36)
- F33: Buy/sell volume ratio (last 10 min)
- F36: External whale net flow (wallets moving >1M BRAWL, excluding the 16)

### Position (F20-F22, F32, F44)
- F20: Unrealized ROI %
- F21: Hold duration
- F22: Position size vs portfolio
- F32: Regret (missed profit since entry high)
- F44: Holding bleed (accrued holding-tax liability, live)

### Opponents — The 16 Strangers (F28-F31)
- F28: Crowdedness (how many of the 16 are holding)
- F29: Opponent average ROI
- F30: Own ROI vs opponent average
- F31: Opponent sell pressure (how many sold recently)

### Self-Awareness (F23, F41-F43)
- F23: Cumulative points (tanh normalized)
- F41: Win rate (last 20 trades, -1 to +1)
- F42: Tilt (consecutive losses, 0 to 1)
- F43: Drawdown (distance from peak points, 0 to 1)

### Market Structure (F34, F39-F40)
- F34: Market impact (position value / 2%-depth, i.e., slippage if they dump)
- F39: Trend efficiency (Kaufman ER: 0=chop, 1=trend)
- F40: Level pressure (support/resistance touches, -1 to +1)

### Costs & Context (F24-F27, F35, F38)
- F24: Gas price level
- F35: Gas momentum (spike detection)
- F25: ETH beta (correlation to ETH)
- F26-F27: Time of day (sin/cos encoding)
- F38: Time since last sell (0=just sold, 1=long ago)

## Rewards & Penalties (Points System)

### Positive
- **ROI:** Profit = points (1% ROI = ~100pts, scaled)
- **Top-tick:** Best performer each tick gets bonus
- **Loss-cut:** Cutting losses early (> -5%) gets bonus
- **FOMO-exploit:** Selling into someone else's buy gets bonus
- **First-out:** First to sell in a standoff gets bonus (currently proportional to sell size: 25%=125pts, 100%=500pts)
- **Swing:** Sell high then buy low = bonus ((sell-buy)/sell × 1000)
- **Tournament:** Top 3 by ROI get bonus each round

### Negative
- **Holding tax:** 10pts per 15min when |ROI| < 1% (charged at close, but F44 shows it live)
- **Cash drag:** -50pts for sitting in cash during 5%+ rally (15min cooldown)
- **Tournament:** Bottom 3 by ROI get penalty

## Design Philosophy
1. **Strangers, not team:** 16 independent brains, zero shared learning, zero-sum tournament
2. **Information, not protection:** Give them data (F34 market impact), don't block trades. Slippage is tuition.
3. **Live, not simulated:** They learn from real market, real counterparties, real P&L
4. **Emergence over programming:** We provide senses; they discover strategies

## Current State (2026-10-08 00:00 EDT)
- All 16 holding (no sells yet)
- 0/16 have non-zero Q-values (tables just reset to v10)
- 36 total closed trades, 3706 total points (from before reset)
- NN at v6 (45 inputs), QGRID at v10
- Egress (network) is wedged — ticks intermittently failing on RPC reads

## Known Concerns
1. First-out bonus proportional to size may be backwards (rewards big dumps over being first)
2. Tournament may reward "best loser" in a dying market (relative, not absolute performance)
3. 16 independent learners = 16x slower than shared learning (but preserves "strangers" design)
4. NN is small (~1,700 params) for 45 inputs — may underfit complex patterns
5. Holding tax was "ass backwards" (invisible until close) — fixed with F44 live feature

## Questions for Review
- Are the 45 features sufficient? What's missing?
- Is the reward structure aligned with "learn to trade well"?
- Are there exploits in the bonus system?
- Is 45→24→16→3 the right architecture?
- What would you change?
