/*
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                         NOTES FOR WREN — READ FIRST                          ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 * Review 2026-10-08. Every change is marked "(review)" inline. Full write-up with
 * priorities and tips: WREN-GUIDE.md. Tests: `npm test` (no network, no money).
 *
 * MENTAL MODEL — what this file actually is:
 *   cron tick -> read pool price -> update 1h-high / 24h-low / buckets -> per wallet:
 *     HOLDING: quote a full exit -> target? NN early exit? hard stop? stop-loss? else hold
 *     FLAT:    bandit picks a combo (dump,value,margin,size,cd) -> any buy signal? -> buy
 *   on close: Q[combo] += ALPHA * (reward - Q[combo])   <- this is a BANDIT, not Q-learning.
 *   There is no next-state, no discounting. "Q-table" = running average reward per arm.
 *
 * THE FIVE THINGS THAT WERE SILENTLY BREAKING LEARNING (all fixed here):
 *   1. NN sizing rewrote the combo key -> closes credited to off-grid keys; the arm
 *      that actually fired never learned. (executeBuy: creditKey)
 *   2. Reward divided LOSSES by hold time -> holding losers was rewarded. (closeReward)
 *   3. Cooldown ran before exits -> no stop-loss for 3-20 min after every buy.
 *   4. The margin arm did nothing -> 1/3 of 432 arms were duplicates.
 *   5. Orphan re-attribution mapped "no dip" to the 30%/70% cell -> the nonzero
 *      Q-values in brains/ were FABRICATED. Treat every live Q-table as empty.
 *
 * UNITS — burn this in:  sq = sqrtPriceX96^2 = price * 2^192. LINEAR in price.
 *   Ratios of sq ARE price ratios. Never sqrt() them, never 0.5*log() them.
 *   (Several features did, so returns/vol/regret were half-size. Fixed.)
 *
 * MONEY MATH AT THIS BANKROLL — why the babies sit still:
 *   ~$0.30 per wallet, ~$0.005-0.02 gas per swap on Base. Exit rule = profit >=
 *   1.5x round-trip gas, so a position needs roughly +10-15% before it may sell.
 *   The thresholds (30-60% crash, 70-90% dip) rarely fire, and a 30%+ ONE-tick
 *   crash can never be bought: the 20% circuit breaker halts trading first.
 *   More "senses" will not fix this; bankroll vs gas and threshold choice will.
 *
 * HARD LINE: these 16 wallets have one owner. They must never trade each other on a
 *   public pool to create activity — that is wash trading whatever the reason.
 *   Fleet-vs-fleet fights belong in sim/tournament.mjs or local-runner/fork-tournament.mjs.
 *   On mainnet the babies trade the MARKET (external counterparties), not each other.
 *   That is why the heartbeat and sibling-FOMO points are now 0.
 *
 * BEFORE YOU SHIP ANY CHANGE: `npm test`, then a fork run
 *   (node local-runner/fork-tournament.mjs --ticks 60), then DRY_RUN=true on live.
 * ════════════════════════════════════════════════════════════════════════════════
 */
/**
 * brawl-trader — 24/7 autonomous BRAWL v2 market-making bot (Cloudflare Workers cron).
 *
 * STRATEGY (Anthony's spec, refined 2026-10-07 13:41 EDT):
 * - 1-MIN LISTENER: cron fires every minute; ticks with <0.50% price move skip trading
 *   (price history still updates) — efficient listening, no wasted gas on dead ticks.
 *   EXCEPT: quiet ticks do NOT skip when price sits at value levels (deep below 1h high
 *   or near 24h low) — the bot must not sleep through a cheap market. (Anthony 2026-10-07
 *   14:26: "you shouldnt have to force it to buy" — the bot was skipping stable lows.)
 * - SPIKE LISTENER: +10% in ONE tick -> immediate exit pass on all wallets in the same
 *   invocation (cooldowns don't block profit). This is the "instant" reaction to pumps.
 * - 16 burner wallets, each INDEPENDENT and COMPETITIVE (no shared signals, no coordination).
 * - %-SIZED buys / ALL-OUT sells: buy X% of post-reserve balance (X is LEARNED per-wallet:
 *   60/70/80 grid). One position per wallet. Sizing scales with portfolio — $0.27 wallet
 *   buys ~$0.16, a $100 wallet buys ~$70. (Anthony 2026-10-07 14:11: fixed $ is wrong.)
 * - BUY SIGNALS (ANY one fires a buy — Anthony 2026-10-07 14:26: the bot must recognize
 *   "price is low", not just "price crashed suddenly"):
 *   1. CRASH BUY: sudden dump >= learned dump threshold (30/40/50/60 grid) in 1-2 ticks.
 *   2. VALUE BUY: price >= learned value threshold (70/80/90 grid) below the 1h high AND
 *      stable (this tick's drop < 10% — not catching a falling knife mid-crash).
 *   3. BOTTOM BUY: price within 10% of the 24h low.
 *   The RL bandit learns which thresholds work; near-24h-low also strengthens any signal.
 *   (Was: dump-only gate at fixed 50%. Anthony: "gotta make it smarter buddy.")
 * - SELL HIGH BAR: profit >= 1.5x total gas cost (buy_gas + sell_gas). No breakeven exits.
 * - SELL INTO ANTHONY: price spike >10% in <5min (likely Anthony buying) -> sell if 1.5x bar met.
 * - STOP-LOSS: down 20%+ with no recovery after 24h held -> sell anyway (discipline).
 * - PATTERN LEARNING: tracks pump/dump swings (>5%) in KV — avg pump/dump size, cycle time.
 * - NEURAL NET (v1, advisory): 32->24->16->3 MLP (ReLU, sigmoid out). Pure JS, ~1.2k params,
 *   per-wallet weights in KV. Inputs: multi-timeframe price (5m/15m/1h/4h/24h), volatility,
 *   pattern regime, wallet state, gas, ETH/USD, hour-of-day. Outputs: buyScore (veto gate),
 *   buySize (continuous %, overrides bandit grid), sellScore (early-exit trigger).
 *   Online backprop (lr 0.01) after every closed trade. Design: NN-DESIGN.md.
 * - REINFORCEMENT LEARNING (bandit): 1pt/profit-cent at 1.5x+ gas, quarter-pt below bar.
 *   Epsilon-greedy (10% explore) over 432 param combos (4 dump × 3 value × 3 margin × 3 size × 4 cooldown).
 *   Q-learning: Q += 0.1 * (reward - Q).
 * - SIZING: % of post-reserve balance per buy (learned: 60/70/80%). Slippage 25% (pool extremely thin).
 *
 * EXECUTION PATH (verified against @zoralabs/coins-sdk tradeCoin):
 * - Quotes: POST https://api-sdk.zora.engineering/quote -> {call:{data,value,target}, quote:{amountOut}}
 * - Buys (ETH->BRAWL): single tx {to: target, data, value}.
 * - Sells (BRAWL->ETH): approve Permit2 + target once per wallet, then trade tx.
 * - Price feed: StateView.getSlot0(poolId) on Base -> sqrtPriceX96 (onchain, no API dependency).
 *
 * STATE (Workers KV, binding TRADER_KV):
 * - price:tick        {sq, ts, prevMoveBps}  sqrtPriceX96^2 from last tick (spike detection)
 * - price:tickPrev    {sq, ts}           2-tick dump window
 * - price:buckets     [{ts, sq}]         rolling 300-tick price history (NN features)
 * - price:high1h      {sq, ts}           rolling 1h high of sqrtPriceX96^2 (dip detection)
 * - price:high1h      {sq, ts}           rolling 1h high of sqrtPriceX96^2 (dip detection)
 * - ethusd:last       {price, ts}        last good ETH/USD
 * - wallet:{i}:position  {buyCostUsd, buyGasUsd, amountWei(str), comboKey, marginAtOpen, buyTx, buyTs} | null
 * - wallet:{i}:qtable    {"40_80_3_70":0,...}   108 Q-values (dump_value_margin_size)
 * - wallet:{i}:stats     {points, trades, wins, losses, pnlUsd, rewards:[...last20]}
 * - wallet:{i}:seed      {dip, margin, size, cooldownMin}   original seeded params (reference)
 * - wallet:{i}:rng       {s}              persistent mulberry32 state
 * - wallet:{i}:lastTrade ts
 * - leaderboard       [{i, points, pnlUsd, trades}]
 * - meta:lastBoardLog ts
 * - meta:lastTickLog   last tick's log lines (debugging)
 *
 * SECRETS (wrangler secret put, NEVER in code):
 * - BURNER_KEY_0 .. BURNER_KEY_15, ZORA_API_KEY
 *
 * DEBUG: set DRY_RUN=true as a Worker variable to log decisions without broadcasting.
 */

// ─── CODE MAP ─────────────────────────────────────────────────────────────────
// This file is only the entry point (Cloudflare `scheduled`/`fetch` handlers + exports).
// The bot lives in src/ — one file per job. See CODEBASE.md for the map, the KV schema
// and the rules for changing anything without breaking the money path.
// ─────────────────────────────────────────────────────────────────────────────

import { selectCombo } from './src/bandit.js';
import { closeReward } from './src/close.js';
import { BRAWL, BURNERS, ERC20_ABI, FLEET_SW, LOW_WINDOW_MS, ORBX_WALLET, OWNER_EOA, SPIKE_MAX_EXITS_PER_TICK } from './src/config.js';
import { ensureSellApproval, getQuote, resolveSellPermits, sendRawTx, waitReceipt } from './src/execution.js';
import { buildFeatures } from './src/features.js';
import { kvGet } from './src/kv.js';
import { bottomSignal, computePriceVelAnn, isOwnerDrivenSpike, poolId, rollLow24 } from './src/market.js';
import { NN_IN } from './src/nn.js';
import { blankQTable, comboKey, parseCombo } from './src/qtable.js';
import { executeSell } from './src/sell.js';
import { acquireTickLock, runTick } from './src/tick.js';

// ------------------------------------------------------------------ handlers ---
export default {
  async scheduled(event, env, ctx) {
    const lines = [];
    const log = (m) => {
      const line = `[${new Date().toISOString()}] ${m}`;
      lines.push(line);
      console.log(line);
    };
    log('=== tick start ===');
    if (!(await acquireTickLock(env, log))) return;
    try {
      await runTick(env, log);
    } catch (e) {
      log(`TICK FATAL: ${e && e.message}`);
    }
    // Persist last tick's log for debugging (fetch /log).
    try {
      await env.TRADER_KV.put('meta:lastTickLog', lines.slice(-150).join('\n'));
    } catch (e) { /* KV write failed — log already in console */ }
  },

  // Read-only ops console (no secrets, no trading): GET /status, /log, /leaderboard.
  // Manual tick trigger: POST /tick (same as cron; for testing or external schedulers).
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/tick' && request.method === 'POST') {
      // (review) This endpoint runs a REAL trading tick for anyone who can reach the
      // worker URL. Set the TICK_TOKEN secret and send it as `x-tick-token`; when the
      // secret is set, requests without it are refused. Unset = legacy open behavior.
      if (env.TICK_TOKEN && request.headers.get('x-tick-token') !== env.TICK_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const lines = [];
      const log = (m) => {
        const line = `[${new Date().toISOString()}] ${m}`;
        lines.push(line);
        console.log(line);
      };
      log('=== manual tick start ===');
      if (!(await acquireTickLock(env, log))) {
        return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain' } });
      }
      try {
        await runTick(env, log);
      } catch (e) {
        log(`TICK FATAL: ${e && e.message}`);
      }
      try {
        await env.TRADER_KV.put('meta:lastTickLog', lines.slice(-150).join('\n'));
      } catch (e) { /* KV write failed */ }
      log('=== manual tick complete ===');
      return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain' } });
    }
    if (url.pathname === '/log') {
      const t = (await env.TRADER_KV.get('meta:lastTickLog')) || '(no ticks yet)';
      return new Response(t, { headers: { 'Content-Type': 'text/plain' } });
    }
    if (url.pathname === '/leaderboard' || url.pathname === '/status') {
      const board = (await kvGet(env, 'leaderboard', []));
      const wallets = [];
      for (let i = 0; i < BURNERS.length; i++) {
        const [pos, stats, seed] = await Promise.all([
          kvGet(env, `wallet:${i}:position`, null),
          kvGet(env, `wallet:${i}:stats`, null),
          kvGet(env, `wallet:${i}:seed`, null),
        ]);
        wallets.push({
          i, address: BURNERS[i], holding: !!pos,
          position: pos ? { ...pos, amountWei: pos.amountWei } : null,
          stats, seed,
        });
      }
      return Response.json({ leaderboard: board, wallets, ts: new Date().toISOString() });
    }
    return new Response('brawl-trader: use /status or /log', { status: 404 });
  },
};

// Named exports for the manual exit script (baby-exit-20261007, Anthony-ordered
// full liquidation). Additive only — does not touch tick logic.
export { executeSell, BURNERS, BRAWL };
// Pure helpers exported for unit tests (test/*.test.mjs). No side effects.
// Internals for the fork tournament's simulated outsiders (same execution path as babies).
export const __internal = { getQuote, resolveSellPermits, sendRawTx, waitReceipt, ensureSellApproval, ERC20_ABI,
  poolId, isOwnerDrivenSpike, OWNER_EOA, ORBX_WALLET, FLEET_SW, SPIKE_MAX_EXITS_PER_TICK };
export const __test = {
  closeReward, rollLow24, bottomSignal, buildFeatures, blankQTable, parseCombo, comboKey,
  selectCombo, computePriceVelAnn, NN_IN, LOW_WINDOW_MS,
};
