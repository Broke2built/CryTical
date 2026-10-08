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

import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  parseEther,
  maxUint256,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------- constants ---
const BRAWL = '0x1378d6A633E64f4abc22c07541473e3551E39b3F';
// BRAWL pool init tx 0x805bd0c37846fd569daf74776f73f138344846f49906506160a044a70d7f3f4d
// (2026-10-07 22:35 EDT). Archive reads for historical price windows must never
// target blocks before this — the pool slot doesn't exist there and getSlot0
// returns zeros, which poisons regime proxies. Clamp windows to >= this block.
// (2026-10-08: this was the true cause of the "non-finite price proxy" failures —
// the 24h-window patch fixed only the advisory window; buys happened ~10 min
// after deploy so the 1h window ALSO predated the pool and hit the same zeros.)
const POOL_DEPLOY_BLOCK = 52318773;
const WETH = '0x4200000000000000000000000000000000000006';
const STATEVIEW = '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const POOLMANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'; // canonical V4 PoolManager on Base (code verified 2026-10-03)
const SWAP_TOPIC0 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'; // Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
// --- PLUS ULTRA senses (Anthony 2026-10-07 23:07: "superhuman eyes and ears") ---
const SWAP_LOOKBACK_BLOCKS = 300;   // ~10 min on Base (2s blocks) — volume/whale window
const WHALE_BRAWL = 1000000;        // single swap moving >1M BRAWL = whale flow
const CIRCUIT_MOVE_PCT = 20;        // >20% in 1 min = halt all trading (ruthless, not reckless)
const CIRCUIT_HALT_MS = 5 * 60e3;   // 5-min cooling halt after a trip
const TWAP_WINDOW_MS = 10 * 60e3;   // 10-min time-weighted average price (manipulation-resistant)
// PoolKey as deployed (birth tick -246000, fee 1%, tickSpacing 200, Zora V4 hook).
// currency0 < currency1: 0x1378... < 0x4200... so BRAWL is currency0.
const POOL_KEY = {
  currency0: BRAWL,
  currency1: WETH,
  fee: 8388608,
  tickSpacing: 200,
  hooks: '0x0469a4Bd3724DC86C9542F4694c976DA13C450c0',
};
const CHAIN_ID = 8453;
const QUOTE_URL = 'https://api-sdk.zora.engineering/quote';
const SLIPPAGE = 0.25; // 25% — BRAWL v2 pool is extremely thin; $0.01 buys revert at 5%

// 16 burner EOAs (addresses are public; PRIVATE KEYS live in Workers secrets).
// `let` so the fork tournament (local-runner/fork-tournament.mjs) can swap in throwaway
// test wallets via env.BURNER_ADDRESSES. On live, leave BURNER_ADDRESSES unset.
let BURNERS = [
  '0x35CdcDe2f918F777edeB72B8dA4928Ce657fdADF',
  '0x191C4bC7D5e70a64ba30A9903C1De4dA75589F23',
  '0xB2f12BC661CE239Ba7607bf7C6b995A8379057E3',
  '0x48F474f5a6211Ae4AB205783F0E0098AB9C71892',
  '0x0C653cb3ECE75Da0ca1A59cAAd4895DA20aAC467',
  '0xaBE70D3707fe5cC1552D234304DF5E9068452c56',
  '0x8260b667eDc1bC004f5B21136E72C0F5EEfB580B',
  '0xF347Df4158BB34019E546284A46197135899EC5a',
  '0x698e5D4E7A49aaDD9d12211edD013F7A05fF0f50',
  '0xf9668E42073c627Eceb6FA2503329AC8708f58aD',
  '0x9aDc821d6022F255660858debAF397bA8cb2a833',
  '0xAdfc49eC07d54308c79a5168eD250D8Bd54a07e5',
  '0x9ae7D79d78bb4925d87394Db2e82C24756CABA7a',
  '0x4fE0e46C0BcCE7AeBe0723f881d0496522221520',
  '0xB72e58C2103F5355f201F8ddfC2EfBe4B850727c',
  '0x9C44D6dF5dDd6fcF9A836Bb11272b1eBac64b9E5',
];

// RL bandit config
let DUMP_GRID = [30, 40, 50, 60];   // crash-buy: sudden-dump entry threshold % (learnable)
                                      // (Anthony 2026-10-07 14:26: thresholds must be learned, not fixed)
let VALUE_GRID = [70, 80, 90];      // value-buy: >=X% below 1h high = cheap (learnable)
const MARGIN_GRID = [1, 3, 5];    // profit margin %
const SIZE_GRID = [60, 70, 80];   // % of post-reserve balance spent per buy — LEARNABLE
                                  // (Anthony 2026-10-07 14:11: fixed $ is wrong; sizing scales with portfolio)
const CD_GRID = [3, 6, 11, 20];   // cooldown minutes between trades — LEARNABLE
                                  // (Anthony 2026-10-07 15:32: fixed cooldowns are bad unless learnable)
const CD_MIN = 2;                 // hard floor: relay/rate sanity
const CD_MAX = 30;                // hard ceiling: no multi-hour stalls from one bad combo pick
const QGRID_VER = 10;             // bump to reset stale Q-tables when the grid changes
                                // v9 (2026-10-07 23:41 EDT): trader-needs audit — NN 39->44 inputs
                                // (F[39] trend efficiency, F[40] level pressure, F[41] win rate,
                                //  F[42] tilt, F[43] drawdown). Old v8 Q-values are
                                //  incompatible with the new feature semantics. Clean reset.
const EPSILON = 0.10;             // base explore rate (dynamically adjusted by arena:avgReward — see #8)
const EPSILON_MIN = 0.05;         // floor for adaptive exploration
const EPSILON_MAX = 0.30;         // ceiling for adaptive exploration
const ALPHA = 0.25;               // Q-learning rate (0.25: ~4 updates to converge — market moves in minutes)
// --- Superintelligence bonuses (Anthony 2026-10-07 23:05: "raise our babies to be super fucking intelligent") ---
const TOP_TICK_DROP_PCT = 5;      // #1: sell, then price drops >=5% in 10 min = called the top
const TOP_TICK_WINDOW_MS = 10 * 60e3;
const TOP_TICK_BONUS_PER_PCT = 500;
const LOSS_CUT_BONUS_PER_PCT = 300; // #2: sold at a loss, price dropped further = smart cut
const FOMO_WINDOW_MS = 2 * 60e3;  // #3: another wallet buys within 2 min after your sell at higher price
// DISABLED (review 2026-10-08): fleet:buyLog only contains OUR wallets, so this bonus
// only ever paid a baby for selling into a SIBLING's buy — same beneficial owner on
// both sides of the flow. That is the onchain shape of a wash trade. Points-only, so
// zeroing it changes no Q-learning; it just stops rewarding self-dealing.
const FOMO_BONUS = 0;             //     (was 200)
const FIRST_OUT_CROWD_THRESH = 0.9; // #4: crowdedness > 0.9 (14.4+/16 holding)...
const FIRST_OUT_WINDOW_MS = 30 * 60e3; // ...and first sell in 30 min = standoff-breaker
const FIRST_OUT_BONUS = 500;
const HOLDING_TAX_PER_15MIN = 10;  // #5: every 15min held with <1% price move bleeds 10pts. No free standoffs. (Anthony 2026-10-07 23:33 EDT: 15min not 1hr)
const HOLDING_TAX_FLAT_PCT = 1.0;
// #7 HEARTBEAT (Anthony 2026-10-08 00:58 EDT): keep the market alive. Every trade (buy or sell)
// earns base heartbeat points, scaled by market flow. Prevents "kill a coin by not doing shit" —
// on a dead coin, trading IS the job (bootstrap momentum). When externals join, the multiplier
// rewards fighting in a live arena. Profit still dominates; heartbeat is the nudge, not the goal.
// DISABLED (review 2026-10-08): paying points for trading-to-keep-a-coin-alive is a
// volume incentive, and 16 wallets with one owner churning a coin for activity is
// exactly what "no fake volume" forbids. Profit is the only thing worth paying for.
const HEARTBEAT_BASE_PTS = 0;       // per trade (was 5)
const HEARTBEAT_MED_FLOW_USD = 1.0; // $1+ volume in window = 2x
const HEARTBEAT_HIGH_FLOW_USD = 10.0; // $10+ volume in window = 3x
const TOURNAMENT_INTERVAL_MS = 24 * 3600e3; // #6: daily zero-sum ranking
const TOURNAMENT_TOP_BONUS = [1000, 600, 300];
const TOURNAMENT_BOT_PENALTY = [300, 600, 1000]; // applied as negative
const SEED_BASE = 1337;
const SEED_STEP = 7919;

// Risk config
const SPIKE_PCT = 10;             // >10% up in one tick = likely Anthony -> sell into it
const QUIET_MOVE_BPS = 50;        // <0.50% tick-to-tick move = quiet tick, skip trading (Anthony 2026-10-07)
const STOP_LOSS_PCT = 18;         // down 18%+ ... (WAS 20, deadlock breaker 2026-10-08 01:20 EDT)
// TEMPORARY (Anthony 2026-10-08 01:20 EDT "get them trading NOW"): 24h -> 2h to break the
// 16-way holding deadlock. Babies are -18% to -20% underwater, 2.4h held, 0 trades in hours.
// Once they're trading again, restore to 24h.
const STOP_LOSS_HOLD_MS = 2 * 3600 * 1000; // ... held 2h+ -> sell anyway (WAS 24h, deadlock breaker)
// Per-wallet stop-loss desync (2026-10-08): a single fixed threshold made all 16
// wallets fire stop-loss within minutes of each other (observed 13:01–13:02 EDT:
// 6 exits in ~90s on a thin pool — emergent synchronized choreography, which
// Anthony forbids). Each wallet derives its OWN threshold deterministically from
// its index (independent mulberry32 stream from seedParams — no KV migration,
// reproducible across ticks). Heterogeneous risk tolerance = 16 independent
// traders, not a herd.
function walletStopLoss(i) {
  const st = { s: (SEED_BASE + i * 7919 + 13) >>> 0 };
  return {
    pct: 14 + rngNext(st) * 12,               // 14–26% (fleet mean ≈ fixed 18)
    holdMs: (1.5 + rngNext(st) * 3) * 3600e3, // 1.5–4.5h (fleet mean ≈ fixed 2h)
  };
}
// MAX-HOLD (deadlock breaker 2026-10-08): orphan-reconciled positions sit underwater
// vs the 1.5x sell gate on a fictional cost basis, and one-position-per-wallet blocks
// fresh buys — structural freeze, 0/16 learning. Orphan positions older than 8h from
// entry (position.buyTs, the reconciliation time) may exit at market, intentionally
// bypassing the 1.5x gate; max ONE exit per tick (precomputed in runTick in index
// order — race-safe across the 4-way batch). Stop-loss is the precedent: exits that
// knowingly lose money to unfreeze a wallet are discipline, not failure.
const ORPHAN_MAX_HOLD_MS = 8 * 3600 * 1000;
const HIGH_WINDOW_MS = 3600 * 1000;         // 1h rolling high for dip detection
const LOW_WINDOW_MS = 24 * 3600 * 1000;     // 24h rolling low for selective entries
const NEAR_LOW_PCT = 10;           // "near 24h low" = within 10% of it (bottom-buy signal)
const STABLE_MAX_DROP_PCT = 10;      // value-buy stability gate: this tick's drop must be <10%
                                     // (not catching a falling knife mid-crash — the crash gate handles those)
const SELL_PROFIT_MULT = 1.5;     // sell only when profit >= 1.5x total gas (Anthony 2026-10-07)
const PARTIAL_SELL_MIN_USD = 5;   // target-hit: at/above this sell value, take 50% + keep a runner (Anthony 2026-10-07)
const PARTIAL_SELL_FRACTION = 0.5;// tranche size on big positions — runner keeps trailing/stop-loss logic
const RUNNER_DUST_USD = 0.01;     // remaining value below this -> just sell 100% (not worth the extra tx)
// NOTE (review 2026-10-08): the ops brief says "0.0002 ETH is untouchable" but this
// was 0.00005. At ~$0.25/wallet a 0.0002 reserve means NO wallet can buy, so the
// default is left as-is; set env GAS_RESERVE_WEI to enforce the documented rule.
const GAS_RESERVE_WEI = 50000000000000n;     // 0.00005 ETH kept back for future txs
// Catastrophic stop (review 2026-10-08): the per-wallet stop-loss only fires after
// 1.5-4.5h held, so a position down 60% in 10 minutes just sat there. This one has
// no time gate.
const HARD_STOP_PCT = 40;
// Bottom-buy structural fix (review 2026-10-08): "within 10% of the 24h low" fired
// on EVERY new low (low resets to now -> 0% above it), i.e. it bought falling knives.
// Now the low must have held for a while AND price must have bounced off it.
const BOTTOM_MIN_LOW_AGE_MS = 30 * 60e3;   // no new low for 30 min
const BOTTOM_MIN_BOUNCE_PCT = 2;            // at least 2% off the low
// Stored lows more than this many x below spot are treated as corrupt (unit mix-ups,
// pre-pool zero reads, inverted pools) — the cause of the "7e29% above low" logs.
const LOW_SANITY_MAX_RATIO = 1000n;
// NN gate (review 2026-10-08): a ~1.6k-param net trained on a handful of closes is a
// random filter. Veto/sizing/early-exit only switch on after this many trained closes;
// before that the NN is scored and logged but has no say.
const NN_MIN_TRAINED = 100;
const BOARD_LOG_MS = 24 * 3600 * 1000;       // log leaderboard every 24h

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
];
// Permit2 AllowanceTransfer.allowance(owner, token, spender) -> (uint160 amount, uint48 expiration, uint48 nonce)
const PERMIT2_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
];
// EIP-712 types for Permit2 PermitSingle (mirrors @zoralabs/coins-sdk tradeCoin.ts)
const PERMIT_SINGLE_TYPES = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
};
const STATEVIEW_ABI = [
  { name: 'getSlot0', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ] },
  // PLUS ULTRA (2026-10-07 23:07): pool liquidity for the 2%-depth market-impact estimate.
  { name: 'getLiquidity', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }] },
];

// ------------------------------------------------------- seeded RNG (mulberry32) ---
// Persistent per-wallet: store {s} in KV so exploration is reproducible across ticks.
function rngNext(st) {
  let s = st.s | 0;
  s = (s + 0x6D2B79F5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  st.s = s;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function seedParams(i) {
  // One-shot deterministic seeding for wallet i's heterogeneous params.
  const st = { s: (SEED_BASE + i * SEED_STEP) >>> 0 };
  const dip = 30 + rngNext(st) * 30;         // 30-60% (matches DUMP_GRID range; legacy log-only field)
  const margin = 1 + rngNext(st) * 4;       // 1-5%
  const size = 60 + rngNext(st) * 20;       // 60-80% of post-reserve balance (Anthony 2026-10-07 14:11)
  const cooldownMin = 5 + rngNext(st) * 10;  // 5-15 min
  return { dip, margin, size, cooldownMin, rngState: st };
}
const snapDump = (d) => DUMP_GRID.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a));
const snapValue = (v) => VALUE_GRID.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const snapMargin = (m) => MARGIN_GRID.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a));
const snapSize = (s) => SIZE_GRID.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
const comboKey = (dump, value, margin, size, cd) => `${dump}_${value}_${margin}_${size}_cd${cd}`;
// Visible non-signal baseline (2026-10-08): orphan closes whose buy-time regime can't
// be reconstructed still get honest Q signal here instead of being dropped or, worse,
// credited to the poisoned 'orphan_0_0_0' key. It lives IN the table (accumulates Q
// visibly) but can NEVER drive bandit selection — selectCombo skips keys whose
// parseCombo fields are non-finite (see below). Never silently mapped to a real combo.
const BASELINE_UNATTRIBUTED_KEY = 'baseline_unattributed';
function blankQTable() {
  const q = {};
  for (const du of DUMP_GRID) for (const v of VALUE_GRID) for (const m of MARGIN_GRID) for (const s of SIZE_GRID) for (const c of CD_GRID) q[comboKey(du, v, m, s, c)] = 0;
  q[BASELINE_UNATTRIBUTED_KEY] = 0; // 433rd key: flagged non-signal baseline, never selectable
  return q;
}
const snapCd = (c) => CD_GRID.reduce((a, b) => (Math.abs(b - c) < Math.abs(a - c) ? b : a));
// One-time in-place migration of 4-dim Q-tables (pre-cd) to 5-dim: the learned Q
// value moves to the cd variant nearest the wallet's seeded cooldown; the other
// cd variants start at 0 so epsilon-greedy explores them naturally. Learned Q is
// never reset by this migration.
function migrateQTableCd(q, seedCdMin) {
  const keys = Object.keys(q);
  if (!keys.length || keys.some((k) => /_cd\d+$/.test(k))) return q;
  const near = snapCd(seedCdMin);
  const nq = {};
  for (const k of keys) {
    const Q = q[k];
    for (const c of CD_GRID) nq[`${k}_cd${c}`] = (c === near ? Q : 0);
  }
  return nq;
}
const parseCombo = (k) => {
  const parts = String(k).split('_');
  const nums = parts.map(Number);
  let cd = 11; // default for legacy 4-dim keys and orphan keys
  if (parts.length >= 5) {
    const m = /^cd(\d+(?:\.\d+)?)$/.exec(parts[4]);
    if (m) cd = Number(m[1]);
  }
  return {
    dump: nums[0], value: nums[1], margin: nums[2], size: (nums[3] || 70), cd,
  };
};
const clampCd = (c) => Math.min(CD_MAX, Math.max(CD_MIN, Number.isFinite(c) ? c : 11));

// ------------------------------------------------------------------ orphan re-attribution ---
// (2026-10-08): orphan positions close with comboKey 'orphan_0_0_0'. The raw orphan key
// must NEVER enter the Q-table — parseCombo yields NaN on it and the bandit could
// then select it (bandit poisoning; the recordClose orphan guard stays). Instead,
// reconstruct the closest HONEST attribution: the onchain market REGIME at the
// wallet's own buy block plus the wallet's seeded params (persistent per-wallet
// thresholds). Real signal (onchain + seeded), not the poisoned orphan key.
// EVERY approximation is documented inline. ANY transport failure -> baseline.
// This function NEVER throws.
async function reconstructBuyCombo(env, publicClient, position, seed, log) {
  // Approximation 0: the wallet's own buy block is unknown in current position
  // records (executeBuy never wrote origBuyBlock — as of 2026-10-08 no record has
  // it). Without a buy block we cannot place the trade in time -> baseline.
  // (review) executeBuy writes `buyBlock`; this used to read only `origBuyBlock`.
  if (position.origBuyBlock == null && typeof position.buyBlock === 'number') position.origBuyBlock = position.buyBlock;
  if (!position.origBuyBlock || typeof position.origBuyBlock !== 'number') {
    log(`reconstructBuyCombo: no origBuyBlock on position — crediting ${BASELINE_UNATTRIBUTED_KEY}`);
    return BASELINE_UNATTRIBUTED_KEY;
  }
  const buyBlock = position.origBuyBlock;
  // Approximation 1: historical price windows as proxies for the LIVE signals:
  //   buyBlock-60   (~2min, Base = 2s blocks) ~ the two-tick drop that fired the buy;
  //   buyBlock-1800 (~1h)                     ~ the 1h-high reference for dip-%;
  //   buyBlock-43200(~24h)                    ~ the 24h-low reference.
  // Approximation 2: dPct is measured from the 1h-AGO PRICE, not the 1h HIGH — the
  // bot buys dips, so price-at-buy vs the hour-ago price is only a proxy for
  // "dip from 1h high" when the high was recent. Documented, not hidden.
  // Approximation 3: windows that predate the pool (buys within ~24h of deploy)
  // clamp to POOL_DEPLOY_BLOCK. A clamped window that still reads zero (slot not
  // yet initialized) is marked UNAVAILABLE and its proxy degrades honestly:
  //   pBuy  (the trade's own block) is REQUIRED — without it, baseline.
  //   p2min unavailable -> dropPct2 = 0 (logged, no fabricated dip).
  //   p1h   unavailable -> dPct falls back to the longest available window
  //          (p2min when present, else 0). The reference is LABELED in the log.
  const blocks = [buyBlock, buyBlock - 60, buyBlock - 1800, buyBlock - 43200]
    .map((b) => Math.max(b, POOL_DEPLOY_BLOCK));
  const pid = poolId();
  const readSlot0At = async (client) => {
    const out = [];
    for (const b of blocks) {
      // Single attempt per block, 15s timeout each. ANY failure -> throw (caller falls back).
      const [sqrtPriceX96] = await raceTimeout(
        client.readContract({
          address: STATEVIEW, abi: STATEVIEW_ABI, functionName: 'getSlot0',
          args: [pid], blockNumber: BigInt(Math.max(b, 0)),
        }), 15000, 'slot0 archive read timeout (15s)');
      out.push(BigInt(sqrtPriceX96) * BigInt(sqrtPriceX96));
    }
    return out;
  };
  // Archive-capable endpoint fallback (2026-10-08): the tick's publicClient is the
  // race winner — publicnode gates archive calls behind a token (2026-10-08 probe:
  // -32602 "Archive requests require a personal token"), drpc and mainnet.base.org
  // serve them. Try the known-good archive hosts FIRST (saves the ~20s token-error
  // round-trip when publicnode won the race), tick client last.
  // Bounded: 3 clients x 4 reads x 15s max. ANY total failure -> baseline.
  // Note: this runs inside the wallet's 45s processing window — 15s/read keeps the
  // common path (~10s/read on drpc) inside it; on timeout the wallet race may
  // abandon this promise but the orphaned continuation still completes the write.
  const mkClient = (url) => {
    try {
      return createPublicClient({ chain: base, transport: http(url, { timeout: 15000 }) });
    } catch { return null; }
  };
  const clients = [
    mkClient('https://base.drpc.org'),
    mkClient('https://mainnet.base.org'),
    publicClient,
  ].filter(Boolean);
  let sqs = null;
  let lastErr = null;
  for (const client of clients) {
    try {
      sqs = await readSlot0At(client);
      break;
    } catch (e) { lastErr = e; }
  }
  if (!sqs) {
    log(`reconstructBuyCombo: archive reads failed on all endpoints (${String((lastErr && lastErr.message) || lastErr).slice(0, 80)}) — crediting ${BASELINE_UNATTRIBUTED_KEY}`);
    return BASELINE_UNATTRIBUTED_KEY;
  }
  // Price proxies: price = (sqrtPriceX96 / 2^96)^2. Ratios only — the 2^192 cancels.
  // The 24h window is advisory only (aboveLowPct is logged, never bucketed): a
  // buy less than 24h after pool deploy reads p24h = 0 (pool didn't exist) — that
  // must not force baseline. The same clamp/degrade logic applies to p2min/p1h:
  // only the trade's own block (pBuy) is required.
  const priceAt = (sq) => Number(sq) / Number(2n ** 192n);
  const [pBuy, p2min, p1h, p24h] = sqs.map(priceAt);
  const winNote = [];
  if (!pBuy || !Number.isFinite(pBuy)) {
    log(`reconstructBuyCombo: no price at buy block ${buyBlock} — crediting ${BASELINE_UNATTRIBUTED_KEY}`);
    return BASELINE_UNATTRIBUTED_KEY;
  }
  const has2min = p2min > 0 && Number.isFinite(p2min);
  const has1h = p1h > 0 && Number.isFinite(p1h);
  if (!has2min) winNote.push('2min window unavailable (pool too young) -> drop proxy 0');
  if (!has1h) winNote.push('1h window unavailable (pool too young)');
  const rawBlocks = [buyBlock, buyBlock - 60, buyBlock - 1800, buyBlock - 43200];
  const clamped1h = rawBlocks[2] < POOL_DEPLOY_BLOCK; // 1h window fell back to pool-birth
  const clampedNote = blocks.some((b, ix) => rawBlocks[ix] < POOL_DEPLOY_BLOCK)
    ? ' (windows clamped to pool deploy block)' : '';
  const dropPct2 = has2min ? (p2min - pBuy) / p2min * 100 : 0;   // % drop over ~2min window (proxy for two-tick drop)
  // dip reference: prefer the 1h window; fall back to 2min when the pool is
  // younger than an hour; 0 only when neither exists. The label says which.
  const dipRef = has1h ? p1h : (has2min ? p2min : 0);
  const dipRefLabel = has1h
    ? (clamped1h ? '~pool-birth price (1h n/a)' : '~1h-ago price')
    : (has2min ? '~2min-ago price (1h n/a)' : 'n/a');
  const dPct = dipRef > 0 ? (dipRef - pBuy) / dipRef * 100 : 0;  // % dip from dip-ref price (proxy for dip-from-1h-high)
  if (winNote.length) log(`reconstructBuyCombo: ${winNote.join('; ')}${clampedNote}`);
  const aboveLowNote = (p24h && Number.isFinite(p24h))
    ? `+${(((pBuy - p24h) / p24h) * 100).toFixed(1)}% vs 24h-ago`
    : '24h-ago n/a (pool did not exist)';
  // Approximation 3: the wallet's seeded params stand in for the firing combo's
  // thresholds — seed is per-wallet persistent (margin/size/cooldownMin) and the
  // dump/value regime comes from the archive reads above.
  // (review) HONESTY CHECK. snapDump(0) = 30 and snapValue(0) = 70, so a buy with NO
  // dip at all used to be credited to the 30%-dump / 70%-dip cell — a combo that could
  // not have fired. That is where every "learned" 30_70_* Q-value in the live tables
  // came from: fabricated attribution. If no grid cell's gate would have fired at the
  // reconstructed regime, the only honest key is the baseline.
  if (dropPct2 < Math.min(...DUMP_GRID) && dPct < Math.min(...VALUE_GRID)) {
    log(`reconstructBuyCombo: regime at buy (drop ~${dropPct2.toFixed(1)}%, dip ~${dPct.toFixed(1)}%) would not fire any grid combo — crediting ${BASELINE_UNATTRIBUTED_KEY}`);
    return BASELINE_UNATTRIBUTED_KEY;
  }
  const dumpB = snapDump(Math.max(0, dropPct2));
  const valueB = snapValue(Math.max(0, dPct));
  const marginB = snapMargin(Number(seed && seed.margin) || 1);
  const sizeB = snapSize(Number(seed && seed.size) || 60);
  const cdB = snapCd(Number(seed && seed.cooldownMin) || 11);
  const key = comboKey(dumpB, valueB, marginB, sizeB, cdB);
  // Sanity: the result must be a real grid cell. An off-grid key would plant the
  // same dead-key poison class as the orphan key itself — never write it.
  if (!(key in blankQTable())) {
    log(`reconstructBuyCombo: off-grid key ${key} — crediting ${BASELINE_UNATTRIBUTED_KEY}`);
    return BASELINE_UNATTRIBUTED_KEY;
  }
  log(`reconstructBuyCombo: orphan re-attributed -> ${key} (proxies: 2min drop ~${dropPct2.toFixed(1)}%, dip-from-${dipRefLabel} ~${dPct.toFixed(1)}%, ${aboveLowNote}; seed margin/size/cd)`);
  return key;
}

// ------------------------------------------------------------------ timeouts (review) ---
// WREN: `Promise.race([work, new Promise(... setTimeout(reject, ms))])` leaves the timer
// running after `work` wins. On Cloudflare that is harmless; in the LOCAL runner (Node)
// every live timer keeps the process alive. The 120s batch timers kept each
// run-tick.mjs process alive ~2 minutes after the tick finished, holding the flock —
// so the "1-minute" fleet actually ticked every 2-3 minutes. Always clear the timer.
function raceTimeout(promise, ms, message) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------------ KV helpers ---
async function kvGet(env, key, fallback = null) {
  try {
    const raw = await env.TRADER_KV.get(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
async function kvPut(env, key, val) {
  await env.TRADER_KV.put(key, JSON.stringify(val));
}

// Retry wrapper for CRITICAL writes (position records). A failed position write
// after an onchain buy = orphan tokens the bot doesn't know it holds.
// (Anthony 2026-10-07 16:15: orphan at 20:11Z — buy tx landed, KV write failed.)
async function kvPutCritical(env, key, val, log, attempts = 3) {
  let lastErr = null;
  for (let a = 1; a <= attempts; a++) {
    try {
      await env.TRADER_KV.put(key, JSON.stringify(val));
      if (a > 1 && log) log(`kvPutCritical ${key} succeeded on attempt ${a}`);
      return;
    } catch (e) {
      lastErr = e;
      if (log) log(`kvPutCritical ${key} attempt ${a}/${attempts} failed: ${String(e.message || e).slice(0, 80)}`);
      if (a < attempts) await new Promise(r => setTimeout(r, 1000 * a));
    }
  }
  throw new Error(`kvPutCritical ${key} failed after ${attempts} attempts: ${String(lastErr?.message || lastErr).slice(0, 120)}`);
}

// ------------------------------------------------------------------ pool math ---
let _poolId = null;
function poolId() {
  if (!_poolId) {
    _poolId = keccak256(
      encodeAbiParameters(
        [{ type: 'tuple', components: [
          { type: 'address', name: 'currency0' },
          { type: 'address', name: 'currency1' },
          { type: 'uint24', name: 'fee' },
          { type: 'int24', name: 'tickSpacing' },
          { type: 'address', name: 'hooks' },
        ] }],
        [[POOL_KEY.currency0, POOL_KEY.currency1, POOL_KEY.fee, POOL_KEY.tickSpacing, POOL_KEY.hooks]]
      )
    );
  }
  return _poolId;
}
// We track sq = sqrtPriceX96^2 as BigInt. Price of BRAWL in WETH = sq / 2^192.
// All signal math (dips, spikes) stays in BigInt — no float precision issues.
async function fetchPoolSq(publicClient) {
  const [sqrtPriceX96] = await publicClient.readContract({
    address: STATEVIEW, abi: STATEVIEW_ABI, functionName: 'getSlot0', args: [poolId()],
  });
  return sqrtPriceX96 * sqrtPriceX96; // BigInt
}
function sqToWethPerBrawl(sq) {
  // float, for USD display only — signals use BigInt sq directly
  return Number(sq) / Number(2n ** 192n);
}
// dipBps > 0 means price fell. spikeBps > 0 means price rose.
const dipBps = (highSq, nowSq) => (highSq > 0n ? Number(((highSq - nowSq) * 10000n) / highSq) : 0);
const riseBps = (oldSq, nowSq) => (oldSq > 0n ? Number(((nowSq - oldSq) * 10000n) / oldSq) : 0);

// ------------------------------------------------------------------ 24h low (review) ---
// WREN, READ THIS: the old rule was "keep the stored low until it is 24h old or price
// goes below it, then reset it to the CURRENT price". Three failures came out of that:
//   1. Every reset and every new low set low = now, so "% above 24h low" was 0 and the
//      BOTTOM signal fired on every down-tick of a downtrend (the 9% win rate).
//   2. One corrupt read (pool not yet initialised, an inverted/other pool's price under
//      the same KV key) stuck for 24h and produced "7e29% above low".
//   3. After 24h the low jumped to spot even if price was far above the real recent low.
// rollLow24 fixes 2 and 3: corrupt lows are discarded, expired lows are rebuilt from the
// price buckets we actually have. bottomSignal (below) fixes 1.
// Returns {sq: string, ts: number} where ts = when THIS low was printed.
function rollLow24(stored, nowSq, now, buckets) {
  const fromBuckets = () => {
    let best = { sq: nowSq, ts: now };
    for (const b of buckets || []) {
      const bsq = BigInt(b.sq);
      if (bsq <= 0n || now - b.ts > LOW_WINDOW_MS) continue;
      if (bsq * LOW_SANITY_MAX_RATIO < nowSq) continue; // same sanity rule as below
      if (bsq < best.sq) best = { sq: bsq, ts: b.ts };
    }
    return { sq: best.sq.toString(), ts: best.ts };
  };
  if (!stored || stored.sq == null) return fromBuckets();
  const lowSq = BigInt(stored.sq);
  if (lowSq <= 0n || lowSq * LOW_SANITY_MAX_RATIO < nowSq) return fromBuckets(); // corrupt
  if (now - stored.ts > LOW_WINDOW_MS) return fromBuckets();                     // expired
  if (nowSq < lowSq) return { sq: nowSq.toString(), ts: now };                   // new low
  return { sq: lowSq.toString(), ts: stored.ts };
}
// BOTTOM BUY: buy the HIGHER LOW, not the new low. Price must be off the low by
// BOTTOM_MIN_BOUNCE_PCT..NEAR_LOW_PCT and the low must not have been broken for
// BOTTOM_MIN_LOW_AGE_MS. This is what "support held" means to a human trader.
function bottomSignal(aboveLowPct, lowAgeMs) {
  return aboveLowPct >= BOTTOM_MIN_BOUNCE_PCT && aboveLowPct <= NEAR_LOW_PCT
    && lowAgeMs >= BOTTOM_MIN_LOW_AGE_MS;
}

// ------------------------------------------------------------------ PLUS ULTRA senses ---
// (Anthony 2026-10-07 23:07: "superhuman eyes and ears, plus ultra")
// All functions are advisory and fail-soft: any RPC failure returns null/neutral
// and the NN falls back to neutral feature values. Senses never break the tick.

// EYES #3+#6: swap flow from PoolManager Swap events (last ~10 min).
// Address-only getLogs (Reth rejects topics arrays — TOOLS.md), client-side filter
// by Swap topic0 + our poolId. amount0 is the BRAWL delta FOR THE POOL:
//   amount0 < 0 → pool paid BRAWL out → trader BOUGHT BRAWL
//   amount0 > 0 → trader sold BRAWL into the pool
// Returns {buyVol, sellVol, whaleNetBrawl} in BRAWL units, or null on failure.
async function fetchSwapFlow(publicClient, log) {
  try {
    const curBlock = await publicClient.getBlockNumber();
    const fromBlock = curBlock > BigInt(SWAP_LOOKBACK_BLOCKS) ? curBlock - BigInt(SWAP_LOOKBACK_BLOCKS) : 0n;
    const logs = await publicClient.getLogs({ address: POOLMANAGER, fromBlock, toBlock: 'latest' });
    const pid = poolId().toLowerCase();
    let buyVol = 0, sellVol = 0, whaleNet = 0, n = 0;
    for (const l of logs) {
      if (!l.topics || l.topics[0]?.toLowerCase() !== SWAP_TOPIC0) continue;
      if (l.topics[1]?.toLowerCase() !== pid) continue; // not our pool
      const dh = l.data.startsWith('0x') ? l.data.slice(2) : l.data;
      if (dh.length < 384) continue;
      const words = [];
      for (let k = 0; k < 6; k++) words.push(BigInt('0x' + dh.slice(k * 64, (k + 1) * 64)));
      // int128 sign-extended to 256 bits in the ABI encoding
      let amount0 = words[0];
      if (amount0 >= 2n ** 255n) amount0 -= 2n ** 256n;
      const brawl = Number(amount0) / 1e18; // signed BRAWL for the pool
      if (brawl < 0) buyVol += -brawl; else sellVol += brawl;
      if (Math.abs(brawl) > WHALE_BRAWL) whaleNet += -brawl; // + = whales net buying
      n++;
    }
    log(`swap flow: ${n} swaps/10m | buy ${buyVol.toFixed(1)} / sell ${sellVol.toFixed(1)} BRAWL | whale net ${whaleNet >= 0 ? '+' : ''}${whaleNet.toFixed(1)}`);
    return { buyVol, sellVol, whaleNetBrawl: whaleNet };
  } catch (e) {
    log(`swap flow failed (${e.message || e}) — volume/whale features neutral`);
    return null;
  }
}

// EYES #4: 2%-depth market-impact estimate from pool liquidity.
// For concentrated liquidity near the current tick: Δy ≈ L · Δ(sqrtP), and a 2%
// price move needs Δ(sqrtP)/sqrtP ≈ 1% (P = sqrtP², so dP/P = 2·d(sqrtP)/sqrtP).
// With sqrtP = sqrt(P) from the float price: depth(WETH) ≈ L · 0.01 · sqrt(P) / 1e18.
// A wallet whose position is 1.0× this depth would eat ~2% slippage exiting all
// at once. Returns WETH, or null on failure.
async function fetchDepth2pctWeth(publicClient, priceWeth, log) {
  try {
    const liq = await publicClient.readContract({
      address: STATEVIEW, abi: STATEVIEW_ABI, functionName: 'getLiquidity', args: [poolId()],
    });
    const depth = Number(liq) * 0.01 * Math.sqrt(priceWeth) / 1e18;
    if (depth > 0 && isFinite(depth)) {
      log(`depth: 2%-move ≈ ${depth.toFixed(4)} WETH (L=${liq.toString()})`);
      return depth;
    }
    return null;
  } catch (e) {
    log(`depth read failed (${e.message || e}) — market-impact feature neutral`);
    return null;
  }
}

// EYES #2: 10-min time-weighted average price (manipulation-resistant).
// Smart money watches TWAP, not the spot print a single trade can push.
function computeTwapSq(buckets, now) {
  try {
    if (!buckets || buckets.length < 2) return null;
    const start = now - TWAP_WINDOW_MS;
    let acc = 0n, total = 0n;
    for (let k = 0; k < buckets.length; k++) {
      const t0 = Math.max(buckets[k].ts, start);
      const t1 = k + 1 < buckets.length ? buckets[k + 1].ts : now;
      if (t1 <= t0 || t1 <= start) continue;
      const dt = BigInt(Math.round(t1 - t0));
      acc += buckets[k].sq * dt;
      total += dt;
    }
    if (total === 0n) return null;
    return acc / total;
  } catch (e) { return null; }
}

// EARS #8: annualized volatility from 1-min log returns (last 60 min).
// Not just "price moved" — HOW FAST. Fast = opportunity or danger.
function computePriceVelAnn(buckets, now) {
  try {
    if (!buckets || buckets.length < 3) return 0;
    const rets = [];
    for (let k = 1; k < buckets.length; k++) {
      const dt = buckets[k].ts - buckets[k - 1].ts;
      if (dt <= 0 || dt > 5 * 60e3) continue;
      if (now - buckets[k].ts > 60 * 60e3) continue;
      const a = buckets[k - 1].sq, b = buckets[k].sq;
      if (a <= 0n || b <= 0n) continue;
      rets.push(Math.log(Number(b) / Number(a))); // sq is linear in price (review fix: was 0.5*log)
    }
    if (rets.length < 2) return 0;
    const m = rets.reduce((s, v) => s + v, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, v) => s + (v - m) * (v - m), 0) / rets.length);
    return sd * Math.sqrt(525600); // per-minute stdev → annualized
  } catch (e) { return 0; }
}

// ------------------------------------------------------------------ ETH/USD ---
// Chainlink ETH/USD feed on Base (read-only fallback when HTTPS price APIs die).
const CHAINLINK_ETHUSD = '0x71041dddad3595F9CEd3DcCFBe3cf133aF4fd0a4';
const CHAINLINK_AGG_ABI = [
  { name: 'latestRoundData', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [
      { name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' } ] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];
const saneEthPrice = p => p > 100 && p < 1000000 && isFinite(p);
async function fetchEthUsd(env, log, publicClient = null) {
  const cached = await kvGet(env, 'ethusd:last', null);
  const tryApi = async (name, url, pick) => {
    try {
      // 25s timeout: degraded egress proven at 8-30s latency (2026-10-02); 10s always dies there.
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      const j = await r.json();
      const p = Number(pick(j));
      if (saneEthPrice(p)) return { name, price: p };
      throw new Error('bad payload');
    } catch (e) {
      log(`${name} failed (${e.message || e})`);
      return null;
    }
  };
  const save = async (p, via) => {
    await kvPut(env, 'ethusd:last', { price: p, ts: Date.now() });
    log(`ETH/USD $${p.toFixed(2)} via ${via}`);
    return p;
  };
  // PLUS ULTRA #9 (2026-10-07 23:07): median-of-3 — query the big three in PARALLEL
  // (one 25s window instead of three sequential), take the median, reject any source
  // more than 2% from the median. A single lying or stale feed can't move us anymore.
  const trio = await Promise.all([
    tryApi('coinbase', 'https://api.coinbase.com/v2/prices/ETH-USD/spot', j => j?.data?.amount),
    tryApi('coingecko', 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', j => j?.ethereum?.usd),
    tryApi('kraken', 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD', j => j?.result?.XETHZUSD?.c?.[0]),
  ]);
  const good = trio.filter(Boolean);
  if (good.length >= 2) {
    const sorted = [...good].sort((a, b) => a.price - b.price);
    const median = sorted.length === 3 ? sorted[1].price : (sorted[0].price + sorted[1].price) / 2;
    const agreeing = sorted.filter(s => Math.abs(s.price - median) / median <= 0.02);
    if (agreeing.length >= 2) {
      const mp = agreeing.length >= 3 ? agreeing[1].price : (agreeing[0].price + agreeing[1].price) / 2;
      return save(mp, `median-of-3 (${agreeing.map(s => s.name).join('+')})`);
    }
    log(`median-of-3: only ${agreeing.length} agree within 2% of median $${median.toFixed(2)} — falling through`);
  } else {
    log(`median-of-3: only ${good.length}/3 feeds answered — falling through`);
  }
  // Backup: binance (single source).
  const b = await tryApi('binance', 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', j => j?.price);
  if (b) return save(b.price, 'binance');
  // Onchain last resort: Chainlink ETH/USD via the already-working RPC path
  // (pool price reads succeed when HTTPS APIs die — different route).
  if (publicClient) {
    try {
      const [, answer, , updatedAt] = await publicClient.readContract({
        address: CHAINLINK_ETHUSD, abi: CHAINLINK_AGG_ABI, functionName: 'latestRoundData',
      });
      const cp = Number(answer) / 1e8;
      const ageHrs = (Date.now() / 1000 - Number(updatedAt)) / 3600;
      if (saneEthPrice(cp) && ageHrs < 24) {
        return save(cp, `chainlink-onchain (${ageHrs.toFixed(1)}h old round)`);
      }
      log(`chainlink onchain bad (price=${cp}, age=${ageHrs.toFixed(1)}h)`);
    } catch (e) {
      log(`chainlink onchain failed (${e.message || e})`);
    }
  }
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
    log(`using stale ETH/USD $${cached.price} (${Math.round((Date.now() - cached.ts) / 60000)}m old)`);
    return cached.price;
  }
  log('ETH/USD UNKNOWN — skipping USD-dependent logic this tick');
  return null;
}

// ------------------------------------------------------------------ Zora quote ---
// POST /quote -> {call:{data,value,target}, quote:{amountOut}} — same contract the SDK uses.
async function getQuote(env, { tokenIn, tokenOut, amountInWei, sender, log, signatures }) {
  const body = {
    tokenIn, tokenOut,
    amountIn: amountInWei.toString(),
    slippage: SLIPPAGE,
    chainId: CHAIN_ID,
    sender, recipient: sender,
  };
  if (signatures) body.signatures = signatures;
  const r = await fetch(QUOTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.ZORA_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!j?.call?.data || !j?.call?.target) {
    throw new Error(`quote failed: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j; // {success, call:{data,value,target}, quote:{amountOut, slippage}, permits?}
}

// Resolve Permit2 permits for a sell quote (mirrors @zoralabs/coins-sdk resolveTradePermits):
// for each quote.permits entry, read the FRESH on-chain nonce, sign EIP-712 PermitSingle,
// and re-request the quote with signatures so the API returns final calldata
// (no REPLACE_WITH_PERMIT_SIGNATURE placeholder).
async function resolveSellPermits(env, publicClient, account, quote, amountInWei, log) {
  if (!quote.permits || quote.permits.length === 0) return quote;
  const owner = account.address;
  const signatures = [];
  for (const p of quote.permits) {
    const det = p.permit.details;
    const token = det.token;
    const spender = p.permit.spender;
    // Fresh on-chain nonce (quote's nonce may be stale)
    const [, , nonce] = await publicClient.readContract({
      address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance',
      args: [owner, token, spender],
    });
    const message = {
      details: {
        token,
        amount: BigInt(det.amount),
        expiration: Number(det.expiration),
        nonce: Number(nonce),
      },
      spender,
      sigDeadline: BigInt(p.permit.sigDeadline),
    };
    log(`permit debug: quoteNonce=${det.nonce} onchainNonce=${nonce} amount=${det.amount} exp=${det.expiration} sigDeadline=${p.permit.sigDeadline} spender=${spender.slice(0, 10)}`);
    const signature = await account.signTypedData({
      domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 },
      types: PERMIT_SINGLE_TYPES,
      primaryType: 'PermitSingle',
      message,
    });
    log(`permit signed: token=${token.slice(0, 10)}... amount=${det.amount} nonce=${nonce}`);
    signatures.push({
      signature,
      permit: {
        details: {
          token: message.details.token,
          amount: String(message.details.amount),
          expiration: message.details.expiration,
          nonce: message.details.nonce,
        },
        spender: message.spender,
        sigDeadline: String(message.sigDeadline),
      },
    });
  }
  // Re-quote with signatures -> final calldata (placeholder replaced by API)
  const final = await getQuote(env, {
    tokenIn: { type: 'erc20', address: BRAWL },
    tokenOut: { type: 'eth' },
    amountInWei,
    sender: owner, log, signatures,
  });
  if ((final.call.data || '').includes('REPLACE_WITH_PERMIT')) {
    throw new Error('requote still has permit placeholder — signature not accepted');
  }
  log('permit resolved: final calldata has real signature');
  return final;
}

// ------------------------------------------------------------------ tx send ---
async function sendRawTx(publicClient, account, { to, data, value }, log, opts = {}) {
  // (2026-10-08: cooperative wallet deadline) a timed-out wallet must NEVER
  // broadcast after its deadline — the tick has moved on and a late broadcast
  // risks double-sells or phantom positions. The abort ONLY gates new
  // broadcasts; in-flight settlement (waitReceipt → recordClose) always runs to
  // completion so a broadcast tx is never left unaccounted.
  if (opts.signal && opts.signal.aborted) {
    throw new Error('sendRawTx: wallet deadline exceeded — refusing post-timeout broadcast');
  }
  let nonce, gasPrice, gasEst;
  try { nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }); }
  catch (e) { throw new Error(`sendRawTx: getTransactionCount failed: ${e.message}`); }
  try { gasPrice = await publicClient.getGasPrice(); }
  catch (e) { throw new Error(`sendRawTx: getGasPrice failed: ${e.message}`); }
  const gasPriceBuf = (gasPrice * 110n) / 100n; // +10%
  try { gasEst = await publicClient.estimateGas({ account: account.address, to, data, value }); }
  catch (e) {
    // Diagnose: run eth_call with identical params to capture the revert data (error selector).
    let selector = 'unknown';
    try {
      await publicClient.call({ account: account.address, to, data, value });
    } catch (ce) {
      const m = String(ce.message || ce).match(/0x[0-9a-fA-F]{8,}/);
      selector = m ? m[0].slice(0, 10) : String(ce.message || ce).slice(0, 120);
    }
    log(`REVERT-DIAG to=${to} selector=${selector} dataLen=${(data || '').length}`);
    throw new Error(`sendRawTx: estimateGas failed: ${e.message} [revert=${selector}]`);
  }
  const gasLimit = (gasEst * 120n) / 100n; // +20% buffer
  const signed = await account.signTransaction({
    to, data, value, nonce, gas: gasLimit, gasPrice: gasPriceBuf, chainId: CHAIN_ID,
  });
  const hash = await publicClient.request({ method: 'eth_sendRawTransaction', params: [signed] });
  log(`sent ${hash} (nonce ${nonce}, gas ${gasLimit}, ${formatEther(gasPriceBuf)} gwei-equiv)`);
  return { hash, gasLimit, gasPrice: gasPriceBuf };
}
async function waitReceipt(publicClient, hash, log, timeoutMs = 90000) {
  const t0 = Date.now();
  let errStreak = 0;
  while (Date.now() - t0 < timeoutMs) {
    try {
      // Per-call timeout: a hung RPC must not wedge the tick (2026-10-07 16:45:
      // w8 stuck 16 min on a non-returning receipt call, flock blocked all ticks).
      const rc = await raceTimeout(
        publicClient.request({ method: 'eth_getTransactionReceipt', params: [hash] }),
        15000, 'receipt call timeout');
      if (rc && rc.blockNumber) return rc;
      errStreak = 0;
    } catch (e) {
      // Some RPCs (e.g. publicnode) reject eth_getTransactionReceipt with
      // "Invalid parameters" — this is an RPC limitation, not a bad tx.
      // Don't throw; return null and let the balance-delta fallback confirm.
      // (2026-10-08: w0 sells were failing because this threw instead of falling back.)
      const msg = String(e.message || e);
      if (msg.includes('Invalid parameters')) {
        log(`waitReceipt: RPC rejects receipt method (${msg.slice(0, 60)}) — using balance-delta fallback`);
        return null;
      }
      // RPC may reject receipt calls (e.g. publicnode archive limits) — don't abort, keep polling.
      errStreak++;
      if (errStreak === 1 || errStreak % 10 === 0) log(`waitReceipt: rpc error (streak ${errStreak}): ${String(e.message || e).slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`no receipt for ${hash} after ${timeoutMs}ms`);
}
const txCostUsd = (gasUsed, gasPriceWei, ethUsd) =>
  Number(formatEther(gasUsed * gasPriceWei)) * ethUsd;

// Approvals for sells: the quote target may pull via Permit2 (Universal Router pattern).
// Approve both target and canonical Permit2 once per wallet — one-time, logged, auditable.
async function ensureSellApproval(publicClient, account, target, amountWei, env, log, dryRun, signal) {
  for (const spender of [target, PERMIT2]) {
    const al = await publicClient.readContract({
      address: BRAWL, abi: ERC20_ABI, functionName: 'allowance',
      args: [account.address, spender],
    });
    if (al >= amountWei) { log(`allowance ok for ${spender.slice(0, 10)}...`); continue; }
    log(`approving ${spender} for BRAWL (maxUint)`);
    if (dryRun) { log('DRY_RUN: skip approve broadcast'); continue; }
    const { hash, gasLimit, gasPrice } = await sendRawTx(publicClient, account, {
      to: BRAWL,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] }),
      value: 0n,
    }, log, { signal });
    const rc = await waitReceipt(publicClient, hash, log);
    if (rc && rc.status !== '0x1') throw new Error(`approve reverted: ${hash}`);
    if (!rc) {
      // 2026-10-08: waitReceipt can return null (RPC rejects the receipt method).
      // NEVER read .status on null (that was the "Cannot read properties of null"
      // crash that aborted sells after a broadcast approve). Confirm via fresh
      // onchain state instead: re-read allowance. Failed/insufficient read =
      // UNKNOWN — throw descriptively, keep the position, NEVER clear or proceed.
      const al2 = await publicClient.readContract({
        address: BRAWL, abi: ERC20_ABI, functionName: 'allowance',
        args: [account.address, spender],
      }).catch(() => null);
      if (al2 === null || al2 < amountWei) {
        throw new Error(`approve UNKNOWN (no receipt, allowance ${al2 === null ? 'read failed' : 'insufficient'}): ${hash} — position retained`);
      }
      log(`approve confirmed via allowance state: ${hash}`);
      continue;
    }
    log(`approve confirmed: ${hash} (gas ${formatEther(BigInt(rc.gasUsed) * gasPrice)} ETH)`);
  }
}

// ------------------------------------------------------------------ RL bandit ---
// Adaptive exploration (2026-10-07 23:05 EDT, superintelligence #8): epsilon
// scales with the fleet's recent learning velocity. Flatline (avg reward < 10)
// -> explore more (break deadlocks). Learning well (avg > 100) -> exploit more.
// WREN — two known weaknesses of this bandit (not changed here, on purpose; test any
// change in sim/tournament.mjs first):
//  (a) SAMPLE SIZE. 432 arms per wallet, ~3 closes per wallet per day. Each arm needs
//      maybe 5-10 samples before its average means anything -> years. Options: a
//      FACTORED bandit (learn dump, value, margin, size, cd as 5 small independent
//      tables: 4+3+3+3+4 = 17 arms), or Thompson sampling instead of epsilon-greedy.
//  (b) RE-ROLL BIAS. While flat, a new combo is drawn EVERY tick and the buy fires if
//      THAT combo's gate passes. Exploration therefore over-credits loose-threshold
//      combos (they pass more often). Fix: draw once after each close and keep it until
//      it trades or N ticks pass.
function selectCombo(qtable, rngState, log, epsilon = EPSILON) {
  // Defense-in-depth (2026-10-08): keys whose parseCombo yields non-finite fields
  // (e.g. 'baseline_unattributed', and any raw 'orphan_*' key that somehow lands in
  // the table) are selectable-IN-table but NEVER selected — a NaN threshold in the
  // live strategy is bandit poisoning. The bandit only ever picks real grid cells.
  let keys = Object.keys(qtable).filter((k) => {
    const p = parseCombo(k);
    return Number.isFinite(p.dump) && Number.isFinite(p.value) && Number.isFinite(p.margin) && Number.isFinite(p.size);
  });
  if (!keys.length) { // unreachable on a sane table (432 grid keys) — fall back loudly, never crash
    log('selectCombo: no finite-parse keys found — falling back to full key set');
    keys = Object.keys(qtable);
  }
  if (rngNext(rngState) < epsilon) {
    const k = keys[Math.floor(rngNext(rngState) * keys.length)];
    log(`bandit EXPLORE (eps ${epsilon.toFixed(2)}): trying combo ${k}`);
    return k;
  }
  let best = keys[0], bestV = -Infinity;
  const tied = [];
  for (const k of keys) {
    if (qtable[k] > bestV) { bestV = qtable[k]; best = k; tied.length = 0; tied.push(k); }
    else if (qtable[k] === bestV) tied.push(k);
  }
  const pick = tied[Math.floor(rngNext(rngState) * tied.length)];
  log(`bandit EXPLOIT: combo ${pick} (Q=${qtable[pick].toFixed(2)})`);
  return pick;
}
// (parseCombo defined with the combo helpers above; carries the learnable cd)

// ------------------------------------------------------------------ neural net ---
// Small MLP: 38 -> 24 (ReLU) -> 16 (ReLU) -> 3 (Sigmoid) = [buyScore, buySize, sellScore]
// Pure JS, zero deps. ~1,387 params. Inference <1ms. Per-wallet weights in KV.
// v1: advisory layer on top of the bandit (veto + sizing + early sell).
// v2 (2026-10-07 23:05 EDT): +1 input (F[32] regret) — 33 inputs. Weights re-init.
// v3 (2026-10-07 23:07 EDT): PLUS ULTRA senses +5 inputs (F[33] volume ratio,
//     F[34] market impact, F[35] gas spike, F[36] whale flow, F[37] price velocity)
//     — 38 inputs. Weights re-init.
// v4 (2026-10-07 23:37 EDT): swing-cycle +1 input (F[38] time-since-sell)
//     — 39 inputs. Weights re-init.
// v5 (2026-10-07 23:41 EDT): trader-needs audit +5 inputs (F[39] trend efficiency,
//     F[40] level pressure, F[41] win rate, F[42] tilt, F[43] drawdown)
//     — 44 inputs. Weights re-init.
// Design: NN-DESIGN.md (Anthony 2026-10-07 14:28: "bigger hidden layer... perfect trader").
const NN_IN = 48, NN_H1 = 24, NN_H2 = 16, NN_OUT = 3;
const NN_LR = 0.01;             // online SGD learning rate (conservative)
const NN_VER = 8;               // bump to re-init all weights (v8: 48 inputs, F[46] rank + F[47] leader gap — FIGHT)
const NN_BUY_GATE = 0.35;       // veto buys when buyScore < this
const NN_SELL_TRIGGER = 0.70;   // early-exit when sellScore > this (and profit bar met)
const NN_COIN = 'brawl';       // weight namespace per coin (transfer learning in v2)

const nnKey = (i) => `nn:weights:${NN_COIN}:${i}`;
const nnPendingKey = (i) => `nn:pending:${i}`;

// Xavier uniform init using the wallet's seeded RNG for reproducibility.
function nnInitWeights(rngState) {
  const xavier = (fanIn, fanOut) => {
    const lim = Math.sqrt(6 / (fanIn + fanOut));
    return () => (rngNext(rngState) * 2 - 1) * lim;
  };
  const mk = (rows, cols) => {
    const g = xavier(cols, rows);
    const m = new Array(rows);
    for (let r = 0; r < rows; r++) { m[r] = new Array(cols); for (let c = 0; c < cols; c++) m[r][c] = g(); }
    return m;
  };
  const zeros = (n) => new Array(n).fill(0);
  return {
    w1: mk(NN_H1, NN_IN), b1: zeros(NN_H1),
    w2: mk(NN_H2, NN_H1), b2: zeros(NN_H2),
    w3: mk(NN_OUT, NN_H2), b3: zeros(NN_OUT),
    ver: NN_VER,
  };
}
async function nnLoad(env, i, rngState) {
  let w = await kvGet(env, nnKey(i), null);
  if (!w) {
    w = nnInitWeights(rngState);
    await kvPut(env, nnKey(i), w);
  } else if (w.ver !== NN_VER) {
    // NETWORK SURGERY (Anthony 2026-10-08: "do it properly, not hammering").
    // Instead of wiping on version bump, preserve learned weights and grow.
    // v6 (45 inputs) → v7 (46 inputs): expand w1 rows from 45→46 cols, new col = 0.
    // The new F[45] input starts with zero weight (no effect), learns gradually.
    // Old 45 inputs keep their learned weights. No amnesia.
    if (w.ver === 6 && NN_VER === 7 && w.w1 && w.w1.length === NN_H1 && w.w1[0].length === 45) {
      for (let r = 0; r < NN_H1; r++) {
        w.w1[r].push(0); // new F[45] input weight starts at 0
      }
      w.ver = NN_VER;
      await kvPut(env, nnKey(i), w);
    } else if (w.ver === 7 && NN_VER === 8 && w.w1 && w.w1.length === NN_H1 && w.w1[0].length === 46) {
      // v7 (46 inputs) → v8 (48 inputs): add F[46] rank + F[47] leader gap, both start at 0.
      for (let r = 0; r < NN_H1; r++) {
        w.w1[r].push(0); // F[46] rank
        w.w1[r].push(0); // F[47] leader gap
      }
      w.ver = NN_VER;
      await kvPut(env, nnKey(i), w);
    } else {
      // Unknown version jump — full re-init (safe fallback)
      w = nnInitWeights(rngState);
      await kvPut(env, nnKey(i), w);
    }
  }
  return w;
}
async function nnSave(env, i, w) {
  await kvPut(env, nnKey(i), w);
}

const relu = (x) => (x > 0 ? x : 0);
const sigmoid = (x) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

// Forward pass. Returns {out:[buyScore,buySize,sellScore], cache} — cache holds
// intermediates for backprop.
function nnForward(w, x) {
  const z1 = new Array(NN_H1), a1 = new Array(NN_H1);
  for (let r = 0; r < NN_H1; r++) {
    let s = w.b1[r];
    const wr = w.w1[r];
    for (let c = 0; c < NN_IN; c++) s += wr[c] * x[c];
    z1[r] = s; a1[r] = relu(s);
  }
  const z2 = new Array(NN_H2), a2 = new Array(NN_H2);
  for (let r = 0; r < NN_H2; r++) {
    let s = w.b2[r];
    const wr = w.w2[r];
    for (let c = 0; c < NN_H1; c++) s += wr[c] * a1[c];
    z2[r] = s; a2[r] = relu(s);
  }
  const out = new Array(NN_OUT);
  const z3 = new Array(NN_OUT);
  for (let r = 0; r < NN_OUT; r++) {
    let s = w.b3[r];
    const wr = w.w3[r];
    for (let c = 0; c < NN_H2; c++) s += wr[c] * a2[c];
    z3[r] = s; out[r] = sigmoid(s);
  }
  return { out, cache: { x, z1, a1, z2, a2, z3 } };
}

// One SGD step. target = [tBuyScore, tBuySize, tSellScore], mask = [m0,m1,m2]
// (mask 0 = don't train that output this step).
function nnTrain(w, cache, target, mask) {
  const { x, z1, a1, z2, a2, z3 } = cache;
  const lr = NN_LR;
  // Output layer deltas: dL/dz3 = (out - t) * sigmoid'(z3) * mask
  const d3 = new Array(NN_OUT);
  for (let r = 0; r < NN_OUT; r++) {
    const o = sigmoid(z3[r]);
    d3[r] = mask[r] ? (o - target[r]) * o * (1 - o) : 0;
  }
  // Gradients for w3, b3
  for (let r = 0; r < NN_OUT; r++) {
    if (d3[r] === 0) continue;
    w.b3[r] -= lr * d3[r];
    const wr = w.w3[r];
    for (let c = 0; c < NN_H2; c++) wr[c] -= lr * d3[r] * a2[c];
  }
  // Backprop to layer 2
  const d2 = new Array(NN_H2).fill(0);
  for (let c = 0; c < NN_H2; c++) {
    let s = 0;
    for (let r = 0; r < NN_OUT; r++) s += w.w3[r][c] * d3[r];
    d2[c] = s * (z2[c] > 0 ? 1 : 0);
  }
  for (let r = 0; r < NN_H2; r++) {
    if (d2[r] === 0) continue;
    w.b2[r] -= lr * d2[r];
    const wr = w.w2[r];
    for (let c = 0; c < NN_H1; c++) wr[c] -= lr * d2[r] * a1[c];
  }
  // Backprop to layer 1
  const d1 = new Array(NN_H1).fill(0);
  for (let c = 0; c < NN_H1; c++) {
    let s = 0;
    for (let r = 0; r < NN_H2; r++) s += w.w2[r][c] * d2[r];
    d1[c] = s * (z1[c] > 0 ? 1 : 0);
  }
  for (let r = 0; r < NN_H1; r++) {
    if (d1[r] === 0) continue;
    w.b1[r] -= lr * d1[r];
    const wr = w.w1[r];
    for (let c = 0; c < NN_IN; c++) wr[c] -= lr * d1[r] * x[c];
  }
  return w;
}

// ------------------------------------------------------------------ fleet stats ---
// Arena opponent-awareness (2026-10-07 22:00 EDT): computed once per tick,
// shared via ctx.fleet to all wallets. Each baby sees the fleet's posture.
//   holdingCount  — wallets currently holding a position (0-16)
//   avgPnlUsd     — mean realized P&L across ALL wallets (competition baseline)
//   avgPnlPct     — mean ROI across wallets with trades (for NN normalization)
//   recentSells   — fleet sells in the last 10 min (sell-pressure signal)
async function computeFleetStats(env, log) {
  const now = Date.now();
  let holdingCount = 0;
  let pnlSum = 0, roiSum = 0, roiN = 0;
  const ownPnl = [];
  for (let i = 0; i < BURNERS.length; i++) {
    try {
      const pos = await kvGet(env, `wallet:${i}:position`, null);
      if (pos) holdingCount++;
      const st = (await kvGet(env, `wallet:${i}:stats`, null)) || {};
      const pnl = st.pnlUsd || 0;
      pnlSum += pnl;
      ownPnl.push(pnl);
      if (st.trades > 0 && st.avgRoi != null) { roiSum += st.avgRoi; roiN++; }
    } catch (e) { ownPnl.push(0); /* one bad wallet never blocks fleet stats */ }
  }
  let recentSells = 0;
  try {
    const sellLog = (await kvGet(env, 'fleet:sellLog', [])) || [];
    const cutoff = now - 10 * 60e3;
    recentSells = sellLog.filter((ts) => ts > cutoff).length;
  } catch (e) { /* advisory */ }
  const fleet = {
    holdingCount,
    avgPnlUsd: pnlSum / BURNERS.length,
    avgPnlPct: roiN > 0 ? (roiSum / roiN) * 100 : 0,
    recentSells,
    ownPnl, // per-wallet realized P&L, index-aligned
    // FIGHT FEATURES (Anthony 2026-10-08 00:45 EDT): rank and leader gap.
    // Each baby sees where it stands vs the other 15. Loser takes risks, winner protects.
    rank: [], // per-wallet rank 0-15 (0=worst, 15=best), index-aligned
    leaderGapUsd: [], // per-wallet USD behind leader (0=leader), index-aligned
  };
  // Compute ranks by P&L (descending)
  const indexed = ownPnl.map((pnl, idx) => ({ pnl, idx }));
  indexed.sort((a, b) => b.pnl - a.pnl);
  const leaderPnl = indexed.length > 0 ? indexed[0].pnl : 0;
  indexed.forEach((item, rank) => {
    fleet.rank[item.idx] = 15 - rank; // 15=best, 0=worst
    fleet.leaderGapUsd[item.idx] = Math.max(0, leaderPnl - item.pnl);
  });
  if (log) log(`fleet: ${holdingCount}/16 holding, avgPnl $${fleet.avgPnlUsd.toFixed(4)}, avgRoi ${fleet.avgPnlPct.toFixed(1)}%, sells10m ${recentSells}`);
  return fleet;
}

// ------------------------------------------------------------------ NN features ---
// 38-feature vector. See NN-DESIGN.md for the full table.
// All values normalized to [-1,1] or [0,1]. Missing data -> neutral 0.5 / 0.
function buildFeatures(o) {
  const {
    buckets,       // [{ts, sq:BigInt}] recent price history (ascending ts)
    nowSq, highSq, low24Sq, prevSq, moveBps,
    pattern,       // {avgPumpPct, avgDumpPct, avgCycleMs, lastExtremeDir}
    ethBal, brawlBal, position, stats,
    gasPriceWei, ethUsd, ethUsdPrev1h, now,
    fleet,         // {holdingCount, avgPnlUsd, avgPnlPct, recentSells, ownPnl[]} — arena opponent-awareness
    walletIdx,     // this wallet's index (for own-vs-fleet comparison)
    // PLUS ULTRA senses (2026-10-07 23:07) — computed once per tick, shared via ctx
    volumeStats,   // {buyVol, sellVol} BRAWL over last ~10 min (from Swap events)
    depth2pctWeth, // WETH that moves price 2% (from pool liquidity)
    positionWeth,  // this wallet's position value in WETH (for market impact)
    gasSpike,      // tanh((gwei - lastTickGwei)/5) — gas momentum
    whaleNetBrawl, // whale (>1M BRAWL) net flow, + = net buying
    priceVelAnn,   // annualized volatility from 1-min returns
    lastSell,      // {ts, sq} of this wallet's most recent sell (swing-cycle, 2026-10-07 23:37)
    dataQuality,   // 0..1 fraction of critical tick reads that succeeded (NEVER BE BLIND)
  } = o;
  const F = new Array(NN_IN).fill(0);
  const clip01 = (v) => Math.max(0, Math.min(1, v));
  const tanh10 = (r) => Math.tanh(r * 10); // log-return -> [-1,1]

  // Helper: log return between two sq values over the bucket history.
  const sqAt = (tsAgoMs) => {
    const t = now - tsAgoMs;
    for (let k = buckets.length - 1; k >= 0; k--) {
      if (buckets[k].ts <= t) return buckets[k].sq;
    }
    return buckets.length ? buckets[0].sq : nowSq;
  };
  const logRet = (fromSq, toSq) => {
    if (!fromSq || fromSq <= 0n || !toSq || toSq <= 0n) return 0;
    // (review) sq = sqrtPriceX96^2 = price * 2^192, i.e. LINEAR in price. The old code
    // assumed sq = price^2 and halved every return/volatility feature.
    return Math.log(Number(toSq) / Number(fromSq));
  };

  // 1-5: multi-timeframe returns
  F[0] = tanh10(logRet(sqAt(5 * 60e3), nowSq));
  F[1] = tanh10(logRet(sqAt(15 * 60e3), nowSq));
  F[2] = tanh10(logRet(sqAt(60 * 60e3), nowSq));
  F[3] = tanh10(logRet(sqAt(4 * 3600e3), nowSq));
  F[4] = tanh10(logRet(sqAt(24 * 3600e3), nowSq));

  // 6-7: volatility (stdev of 1-min log returns)
  const rets5m = [], rets1h = [];
  for (let k = 1; k < buckets.length; k++) {
    const dt = buckets[k].ts - buckets[k - 1].ts;
    if (dt <= 0 || dt > 5 * 60e3) continue;
    const r = logRet(buckets[k - 1].sq, buckets[k].sq);
    const age = now - buckets[k].ts;
    if (age <= 5 * 60e3) rets5m.push(r);
    if (age <= 60 * 60e3) rets1h.push(r);
  }
  const stdev = (a) => {
    if (a.length < 2) return 0;
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
  };
  F[5] = clip01(stdev(rets5m) * 20);
  F[6] = clip01(stdev(rets1h) * 20);

  // 8-9: dip below 1h high / above 24h low
  F[7] = clip01(dipBps(highSq, nowSq) / 100 / 100); // dipBps->pct->0..1
  const aboveLow = nowSq > low24Sq ? Number((nowSq - low24Sq) * 10000n / low24Sq) / 100 : 0;
  F[8] = clip01(aboveLow / 200);

  // 10-11: tick move + acceleration
  F[9] = Math.tanh((moveBps / 100) / 5);
  const prevMove = o.prevMoveBps != null ? o.prevMoveBps / 100 : 0;
  F[10] = Math.tanh(((moveBps / 100) - prevMove) / 5);

  // 12: position in 1h range
  const hi = Number(highSq), lo = Number(low24Sq), px = Number(nowSq);
  F[11] = (hi > lo) ? clip01((px - lo) / (hi - lo)) : 0.5;

  // 13-18: pattern regime
  F[12] = clip01((pattern?.avgPumpPct || 0) / 100);
  F[13] = clip01((pattern?.avgDumpPct || 0) / 100);
  F[14] = clip01(Math.log10(1 + (pattern?.avgCycleMs || 0) / 60000) / 3);
  F[15] = pattern?.lastExtremeDir === 'pump' ? 1 : 0;
  F[16] = pattern?.lastExtremeDir === 'dump' ? 1 : 0;
  F[17] = clip01((pattern?.swings1h || 0) / 10);

  // 19-24: wallet state
  const ethN = Number(ethBal) / 1e18;
  const slipN = Number(brawlBal) / 1e18;
  F[18] = clip01(Math.log10(1 + ethN) / 2);
  F[19] = clip01(Math.log10(1 + slipN) / 7);
  if (position && position.buyCostUsd > 0) {
    const pnlPct = o.unrealizedPnlPct != null ? o.unrealizedPnlPct : 0;
    F[20] = Math.tanh(pnlPct / 50);
    F[21] = clip01((now - position.buyTs) / (24 * 3600e3));
    F[22] = 1;
  } else {
    F[20] = 0; F[21] = 0; F[22] = 0;
  }
  F[23] = Math.tanh((stats?.points || 0) / 500);

  // 25-28: market
  const gwei = Number(gasPriceWei) / 1e9;
  F[24] = clip01(Math.log10(1 + gwei) / 2);
  const ethRet = (ethUsdPrev1h && ethUsdPrev1h > 0)
    ? (ethUsd - ethUsdPrev1h) / ethUsdPrev1h : 0;
  F[25] = Math.tanh(ethRet * 50);
  const d = new Date(now);
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60; // UTC hour (fine for cyclical)
  F[26] = Math.sin(2 * Math.PI * hr / 24);
  F[27] = Math.cos(2 * Math.PI * hr / 24);

  // 29-32: fleet opponent-awareness (arena, 2026-10-07 22:00 EDT)
  // Each baby sees the competition: crowdedness, relative standing, sell pressure.
  // Neutral fallbacks preserve v1 behavior when fleet data is unavailable.
  if (fleet) {
    // F[28]: fleet crowdedness — fraction of the 16 currently holding
    F[28] = clip01(fleet.holdingCount / 16);
    // F[29]: fleet average ROI — is the arena winning or losing overall?
    F[29] = Math.tanh((fleet.avgPnlPct || 0) / 50);
    // F[30]: own P&L vs fleet average — am I beating the competition?
    const own = (walletIdx != null && fleet.ownPnl) ? (fleet.ownPnl[walletIdx] || 0) : (stats?.pnlUsd || 0);
    F[30] = Math.tanh((own - (fleet.avgPnlUsd || 0)) * 200); // $0.005 diff -> ~0.76
    // F[31]: recent fleet sell pressure — sells in last 10 min (0-8+ -> 0..1)
    F[31] = clip01((fleet.recentSells || 0) / 8);
  } else {
    F[28] = 0.5; F[29] = 0.5; F[30] = 0.5; F[31] = 0.5;
  }

  // F[32]: max regret — (highest price since entry - current price) / entry price
  // (2026-10-07 23:05 EDT, superintelligence #7). If you held through a 20%
  // peak-to-trough, F[32] ≈ 0.20. The NN learns: high regret = should have sold.
  // Computed from bucket history: peak sq since buyTs vs entry sq vs current.
  F[32] = 0;
  if (position && position.buyTs && buckets && buckets.length > 0 && nowSq > 0n) {
    try {
      const entrySq = sqAt(now - position.buyTs);
      if (entrySq > 0n) {
        let peakSq = entrySq;
        for (const b of buckets) {
          if (b.ts >= position.buyTs && b.sq > peakSq) peakSq = b.sq;
        }
        // regret = (peakPrice - nowPrice) / entryPrice  (sq is linear in price)
        const eN = Number(entrySq);
        const regret = (Number(peakSq) - Number(nowSq)) / eN;
        F[32] = clip01(Math.max(0, regret));
      }
    } catch (e) { F[32] = 0; /* regret is advisory — never break features */ }
  }

  // F[33]-F[37]: PLUS ULTRA senses (2026-10-07 23:07) — superhuman eyes and ears.
  // F[33]: buy/sell volume ratio (last ~10 min, from Swap events). 0.5 = balanced.
  //   Buys >> sells → momentum up. Neutral 0.5 when no swaps seen.
  F[33] = (volumeStats && (volumeStats.buyVol + volumeStats.sellVol) > 0)
    ? clip01(volumeStats.buyVol / (volumeStats.buyVol + volumeStats.sellVol)) : 0.5;
  // F[34]: market impact — my position as a fraction of the 2%-move depth.
  //   1.0 = exiting all at once eats ~2% slippage. w0 (57M BRAWL) watches this.
  //   0 = flat (no impact). Neutral 0 when depth unknown.
  F[34] = (depth2pctWeth && depth2pctWeth > 0 && positionWeth)
    ? clip01(positionWeth / depth2pctWeth) : 0;
  // F[35]: gas spike — tanh((gwei - lastTickGwei)/5). Spiking gas → re-time the
  //   exit; the 1.5x profit gate is gas-sensitive in real time. 0 = stable.
  F[35] = gasSpike != null ? Math.max(-1, Math.min(1, gasSpike)) : 0;
  // F[36]: whale net flow (last ~10 min, BRAWL, swaps >1M). + = whales net buying.
  //   The NN already sees fleet flow (F[28-31]); F[36] lets it learn the difference
  //   between fleet moves and true external whales.
  F[36] = whaleNetBrawl != null ? Math.tanh(whaleNetBrawl / 10000000) : 0;
  // F[37]: price velocity — annualized volatility from 1-min returns.
  //   1000% ann vol → 1.0. Fast = opportunity or danger. 0 = dead flat.
  F[37] = priceVelAnn != null ? clip01(priceVelAnn / 10) : 0;

  // F[38]: time since last sell — swing-cycle awareness (2026-10-07 23:37 EDT).
  //   0 = just sold (within 5 min, re-entry window open), 1 = sold >24h ago or
  //   never sold. Helps the NN learn: "I just sold — buy the dip back now or wait?"
  //   Works with the swing bonus: low F[38] + price below last sell = buy-back setup.
  F[38] = 1;
  if (lastSell && lastSell.ts) {
    const sinceSellMs = now - lastSell.ts;
    F[38] = clip01(sinceSellMs / (24 * 3600e3));
  }

  // F[39]-F[43]: trader-needs audit (2026-10-07 23:41 EDT, Anthony: "do it").
  //   What a real trader knows that the babies couldn't see: regime, levels, self.
  // F[39]: trend efficiency — Kaufman Efficiency Ratio over 30 one-min buckets.
  //   |P_now - P_30m_ago| / sum|P_t - P_{t-1}|. 0 = pure chop (every move reverses),
  //   1 = straight trend (every move continues). The #1 trader question: trending
  //   or ranging? Trends → buy dips, let winners run. Ranges → fade extremes.
  //   Fail-soft 0.5 (neutral) when <10 buckets.
  F[39] = 0.5;
  try {
    if (buckets && buckets.length >= 10) {
      // Take up to 31 most recent buckets for 30 one-min intervals.
      const n = Math.min(buckets.length, 31);
      const recent = buckets.slice(buckets.length - n);
      const px = (sq) => Number(sq); // linear in price (review fix: was sqrt)
      const pNow = px(recent[recent.length - 1].sq);
      const pAgo = px(recent[0].sq);
      let pathSum = 0;
      for (let k = 1; k < recent.length; k++) {
        pathSum += Math.abs(px(recent[k].sq) - px(recent[k - 1].sq));
      }
      if (pathSum > 0) {
        F[39] = clip01(Math.abs(pNow - pAgo) / pathSum);
      }
    }
  } catch (e) { F[39] = 0.5; /* regime is advisory — never break features */ }

  // F[40]: level pressure — support/resistance battle detector.
  //   (touches of 1h high - touches of 1h low) in last 4h, tanh-normalized.
  //   +1 = pressing resistance (breakout brewing), -1 = hammering support
  //   (breakdown brewing). Touch = bucket close within 0.5% of the level
  //   (sq is linear in price, so 0.5% in sq = 0.5% in price). Traders trade levels.
  //   Fail-soft 0 when levels unknown.
  F[40] = 0;
  try {
    if (highSq > 0n && low24Sq > 0n && highSq > low24Sq && buckets && buckets.length > 0) {
      const hiN = Number(highSq), loN = Number(low24Sq);
      const cutoff4h = now - 4 * 3600e3;
      let touchHi = 0, touchLo = 0;
      for (const b of buckets) {
        if (b.ts < cutoff4h) continue;
        const sqN = Number(b.sq);
        if (sqN <= 0) continue;
        // Within 0.5% of the level (sq is linear in price — review fix: was 1%).
        if (Math.abs(sqN - hiN) / hiN < 0.005) touchHi++;
        if (Math.abs(sqN - loN) / loN < 0.005) touchLo++;
      }
      F[40] = Math.tanh((touchHi - touchLo) / 4);
    }
  } catch (e) { F[40] = 0; /* levels are advisory — never break features */ }

  // F[41]: win rate — self-awareness. (wins_last20 / 20 - 0.5) * 2 → [-1, 1].
  //   +1 = hot (20/20 wins), -1 = ice cold (0/20). Lets the NN learn Kelly-style
  //   sizing: big when proven, small when cold. Fail-soft 0 for fresh wallets.
  F[41] = 0;
  try {
    if (stats && stats.trades > 0) {
      // (review) prefer real P&L history; shaped rewards are a fallback for old stats.
      const rw = stats.pnlHistory && stats.pnlHistory.length ? stats.pnlHistory : (stats.rewards || []);
      if (rw.length > 0) {
        const wins20 = rw.filter((r) => r > 0).length;
        F[41] = (wins20 / rw.length - 0.5) * 2;
      } else {
        // Fall back to cumulative counters when rewards history is absent.
        F[41] = ((stats.wins || 0) / stats.trades - 0.5) * 2;
      }
    }
  } catch (e) { F[41] = 0; /* self-stats are advisory */ }

  // F[42]: tilt — consecutive-loss detector. tanh(streak / 3) → [0, 1).
  //   0 = no tilt (last trade won or fresh), →1 = deep tilt (5+ straight losses).
  //   After repeated losses the learned policy is likely miscalibrated to the
  //   current regime — size should shrink until edge re-proves. Fail-soft 0.
  F[42] = 0;
  try {
    const streak = (stats && stats.streak) || 0;
    F[42] = Math.tanh(streak / 3);
  } catch (e) { F[42] = 0; /* tilt is advisory */ }

  // F[43]: drawdown — distance from peak equity. (peakPoints - points) / peakPoints.
  //   0 = at all-time high, →1 = deep hole. Capital preservation mode: deep
  //   drawdown → fewer chances, tighter exits. Fail-soft 0 (fresh or at peak).
  F[43] = 0;
  try {
    const pts = (stats && stats.points) || 0;
    const peak = (stats && stats.peakPoints) || 0;
    if (peak > 0 && pts < peak) {
      F[43] = clip01((peak - pts) / peak);
    }
  } catch (e) { F[43] = 0; /* drawdown is advisory */ }

  // F[44]: holding bleed — LIVE accrued holding-tax liability (2026-10-08 00:04 EDT,
  //   Anthony: "yea we need to improve that line of thinking...").
  //   The tax itself is still deducted at recordClose(); this feature exposes the
  //   accruing bill so the NN FEELS the clock ticking instead of sitting free.
  //   Same rule as recordClose: 10pts per 15min held while |ROI| < 1%.
  //   F[44] = clip01(accruedPts / 100). 0 = fresh or winning (no bleed),
  //   →1 = 100+ pts bleeding (deep standoff). Fail-soft 0 (no position).
  F[44] = 0;
  try {
    if (position && position.buyTs && now > position.buyTs) {
      const pnlPctLive = o.unrealizedPnlPct != null ? o.unrealizedPnlPct : 0;
      if (Math.abs(pnlPctLive) < HOLDING_TAX_FLAT_PCT) {
        const holdMinutes = (now - position.buyTs) / 60000;
        const periods = Math.floor(holdMinutes / 15);
        if (periods >= 1) {
          const accrued = periods * HOLDING_TAX_PER_15MIN;
          F[44] = clip01(accrued / 100);
        }
      }
    }
  } catch (e) { F[44] = 0; /* bleed is advisory — never break features */ }

  // F[45]: data quality — NEVER BE BLIND (Anthony 2026-10-08 00:17 EDT:
  //   "they can never be blind. they can never fail.")
  //   What % of critical data reads succeeded this tick?
  //   1.0 = all fresh, 0.0 = flying blind. Low quality → DO NOT TRADE.
  //   This is intelligent abstention, not the tournament exploit.
  //   Fail-soft: 1.0 (assume good if missing — the tick aborted already if truly blind)
  //   (2026-10-08 fix: was reading out-of-scope `ctx.dataQuality` — always 1.0.
  //   Now passed explicitly through buildFeatures' input object.)
  F[45] = 1.0;
  try {
    if (typeof dataQuality === 'number') {
      F[45] = clip01(dataQuality);
    }
  } catch (e) { F[45] = 1.0; }

  // F[46]: my rank — where do I stand vs the other 15? (Anthony 2026-10-08 00:45 EDT)
  //   1.0 = #1 (leader), 0.0 = #16 (last). Loser takes risks, winner protects.
  //   Fail-soft 0.5 (middle) if fleet data missing.
  F[46] = 0.5;
  try {
    if (fleet && fleet.rank && typeof walletIdx === 'number' && fleet.rank[walletIdx] != null) {
      F[46] = clip01(fleet.rank[walletIdx] / 15);
    }
  } catch (e) { F[46] = 0.5; }

  // F[47]: leader gap — how far behind #1 am I, in USD? (Anthony 2026-10-08 00:45 EDT)
  //   0.0 = I'm the leader, →1.0 = far behind. Creates urgency.
  //   Normalized: $0.50 gap = 1.0 (babies trade in cents, not dollars).
  //   Balanced for wild competition: based on realized P&L (public onchain), not perfect info.
  //   Fail-soft 0 (assume leader) if missing.
  F[47] = 0;
  try {
    if (fleet && fleet.leaderGapUsd && typeof walletIdx === 'number' && fleet.leaderGapUsd[walletIdx] != null) {
      F[47] = clip01(fleet.leaderGapUsd[walletIdx] / 0.5);
    }
  } catch (e) { F[47] = 0; }

  return F;
}

// ------------------------------------------------------------------ buy ---
// %-SIZED: buy combo.size % of post-reserve balance (Anthony 2026-10-07 14:11 —
// fixed $ is wrong; sizing scales with portfolio. The % is learnable via the RL grid).
async function executeBuy(ctx, i, combo, dipPct, log) {
  const { env, publicClient, ethUsd, priceWeth, dryRun } = ctx;
  const addr = BURNERS[i];

  const ethBal = await publicClient.getBalance({ address: addr });
  // Reserve: gas for this buy + gas for the eventual sell + dust.
  // (Anthony 2026-10-07 16:28: lowered from 4x to 1x GAS_RESERVE so the
  //  $0.27-funded burners can trade — 0.00005 reserve leaves ~$0.10/trade.)
  const reserve = env.GAS_RESERVE_WEI ? BigInt(env.GAS_RESERVE_WEI) : GAS_RESERVE_WEI;
  if (ethBal <= reserve) {
    log(`SKIP buy: balance ${formatEther(ethBal)} ETH <= reserve ${formatEther(reserve)} ETH`);
    return null;
  }
  const avail = ethBal - reserve;
  const buyWei = (avail * BigInt(combo.size)) / 100n;
  const buyUsd = Number(formatEther(buyWei)) * ethUsd;
  log(`buy ${combo.size}% of available: ${formatEther(buyWei)} ETH ($${buyUsd.toFixed(4)})`);

  const q = await getQuote(env, {
    tokenIn: { type: 'eth' },
    tokenOut: { type: 'erc20', address: BRAWL },
    amountInWei: buyWei, sender: addr, log,
  });
  const target = q.call.target;
  log(`quote target=${target} amountOut=${q.quote.amountOut} brawl-wei`);

  if (dryRun) { log('DRY_RUN: skip buy broadcast'); return null; }

  // (review) Q-credit key = the GRID cell the bandit picked. The old code rebuilt the
  // key from combo.size, which the NN overrides with any integer 10-100 — so a close
  // was credited to e.g. "30_70_3_47_cd6", a key that is not in the grid, and the
  // combo that actually fired never learned anything.
  const creditKey = combo.key || comboKey(combo.dump, combo.value, combo.margin, combo.size, clampCd(combo.cd));
  // (review) WRITE-AHEAD: record what we are about to do BEFORE broadcasting. If the
  // tx lands but the position write below fails, orphan reconciliation reads this and
  // keeps the true combo key instead of inventing one. This is the root fix for the
  // "everything lands in baseline_unattributed" problem.
  await kvPutCritical(env, `wallet:${i}:pendingBuy`, { comboKey: creditKey, sizePct: combo.size, ts: Date.now() }, log);

  const account = privateKeyToAccount(env[`BURNER_KEY_${i}`]);
  let hash, gasPrice;
  try {
    ({ hash, gasPrice } = await sendRawTx(publicClient, account, {
      to: target, data: q.call.data, value: BigInt(q.call.value || '0'),
    }, log, { signal: ctx.signal }));
  } catch (e) {
    // Nothing was broadcast — a stale write-ahead record would mislabel a later orphan.
    await kvPut(env, `wallet:${i}:pendingBuy`, null).catch(() => {});
    throw e;
  }
  let rc = null;
  try {
    rc = await waitReceipt(publicClient, hash, log);
    if (rc && rc.status !== '0x1') throw new Error(`buy reverted: ${hash}`);
    if (!rc) throw new Error('receipt unavailable — balance-delta fallback');
  } catch (e) {
    if (String(e.message || '').startsWith('buy reverted')) {
      await kvPut(env, `wallet:${i}:pendingBuy`, null).catch(() => {}); // reverted = no tokens = no orphan
      throw e;
    }
    log(`buy waitReceipt failed (${String(e.message).slice(0, 80)}) — balance-delta fallback`);
    // Retry: the buy often lands 10-40s after the receipt poll gives up.
    let balCheck = 0n;
    for (let attempt = 0; attempt < 6; attempt++) {
      balCheck = await publicClient.readContract({
        address: BRAWL, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr],
      }).catch(() => 0n);
      if (balCheck > 0n) break;
      if (attempt < 5) await new Promise((r) => setTimeout(r, 10000));
    }
    if (balCheck === 0n) throw new Error(`buy unconfirmed after 60s: no receipt and zero BRAWL balance`);
    log(`RECEIPT-FALLBACK: buy confirmed via BRAWL balance ${balCheck}, proceeding without receipt`);
  }
  const buyGasUsd = txCostUsd(rc ? BigInt(rc.gasUsed) : 300000n, gasPrice, ethUsd);

  // Actual received = onchain balance (exact, not quote estimate).
  const balAfter = await publicClient.readContract({
    address: BRAWL, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr],
  });
  const buyCostUsd = Number(formatEther(buyWei)) * ethUsd;
  const buyGasWei = gasPrice * (rc ? BigInt(rc.gasUsed) : 300000n);
  const position = {
    buyCostUsd, buyGasUsd,
    amountWei: balAfter.toString(),
    buyPriceWeth: priceWeth,
    comboKey: creditKey,
    marginAtOpen: combo.margin,
    sizeAtOpen: combo.size,
    buyTx: hash, buyTs: Date.now(),
    // Buy block for honest combo re-attribution (2026-10-08 deadlock breaker):
    // if this position ever closes as an orphan, reconstructBuyCombo uses the
    // onchain regime at THIS block. Null when the receipt was unavailable.
    buyBlock: rc ? Number(rc.blockNumber) : null,
    // Post-buy ETH balance — stale-clear profit reconstruction baseline:
    // a later sale shows up as ethNow - ethBalPostBuy > 0.
    ethBalPostBuy: (ethBal - buyWei - buyGasWei).toString(),
  };
  await kvPutCritical(env, `wallet:${i}:position`, position, log);
  await kvPut(env, `wallet:${i}:pendingBuy`, null); // position is durable — write-ahead consumed
  await kvPutCritical(env, `wallet:${i}:lastTrade`, Date.now(), log);
  log(`BOUGHT ${formatEther(balAfter)} BRAWL for $${buyCostUsd.toFixed(4)} (+$${buyGasUsd.toFixed(4)} gas) tx ${hash}`);
  // ---- Fleet buy log (2026-10-07 23:05 EDT, superintelligence #3 FOMO-exploit) ----
  // Sellers check this log: if someone buys within 2 min after your sell at a
  // higher price, you sold into their FOMO (+200pts). Prune to 15 min on write.
  try {
    const buyLog = (await kvGet(env, 'fleet:buyLog', [])) || [];
    const cutoff = Date.now() - 15 * 60e3;
    const pruned = buyLog.filter((b) => b.ts > cutoff);
    pruned.push({ ts: Date.now(), walletIdx: i, priceSq: ctx.nowSq.toString() });
    await kvPut(env, 'fleet:buyLog', pruned);
  } catch (e) { /* buy log is advisory — never block the buy */ }
  // ---- Swing bonus (2026-10-07 23:37 EDT): bought back in below last sell price.
  // Full swing-trade cycle: sell high -> buy the dip -> bonus scales with the dip.
  // sold $100, rebought $90 = 10% dip = +100pts. Goes to stats.points directly
  // (post-hoc style reward, like the ruthlessness bonuses — not Q-attributable
  // to the entry combo). Clears lastSell so it can't double-count.
  try {
    const ls = await kvGet(env, `wallet:${i}:lastSell`, null);
    if (ls && ls.sq) {
      const sellSqN = Number(BigInt(ls.sq));
      const buySqN = Number(ctx.nowSq);
      if (sellSqN > 0 && buySqN > 0 && buySqN < sellSqN) {
        // (review) sq = sqrtPriceX96^2 is LINEAR in price (price = sq / 2^192), not
        // price^2 — the old sqrt() here halved every swing bonus.
        const dipFrac = 1 - buySqN / sellSqN; // price dip fraction
        const swingBonus = Math.round(dipFrac * 1000);
        if (swingBonus > 0) {
          const st = (await kvGet(env, `wallet:${i}:stats`, null)) || { points: 0 };
          st.points = (st.points || 0) + swingBonus;
          await kvPut(env, `wallet:${i}:stats`, st);
          const sellPx = sellSqN / 2 ** 192, buyPx = buySqN / 2 ** 192;
          log(`SWING BONUS: +${swingBonus}pts (sold ${sellPx.toExponential(3)}, rebought ${buyPx.toExponential(3)}, ${(dipFrac * 100).toFixed(1)}% dip)`);
        }
      }
      await kvPut(env, `wallet:${i}:lastSell`, null); // consumed — one bonus per sell
    }
  } catch (e) { /* swing bonus is advisory — never break the buy */ }
  // #7 HEARTBEAT (Anthony 2026-10-08 00:58 EDT): buys keep the market alive too.
  // Base points scaled by flow — rewards trading, not just profit.
  try {
    const hb = heartbeatPts(ctx);
    if (hb > 0) {
      const sth = (await kvGet(env, `wallet:${i}:stats`, null)) || { points: 0 };
      sth.points = (sth.points || 0) + hb;
      await kvPut(env, `wallet:${i}:stats`, sth);
      log(`HEARTBEAT: +${hb}pts (buy kept the market alive)`);
    }
  } catch (e) { /* heartbeat is advisory — never break the buy */ }
  return position;
}

// ------------------------------------------------------------------ close accounting ---
// Shared trade-close accounting (Anthony 2026-10-07 15:25): ROI is the goal,
// profit-per-hour is the speed metric.
//   ROI       = profitUsd / (buyCostUsd + buyGasUsd)   [realized portion only]
//   holdHours = (sellTs - buyTs) / 3600000            [>= 1s epsilon]
//   reward    = round(ROI * 10000 / (1 + holdHours))   [ROI in basis points, time-discounted]
// (2026-10-07 22:00 EDT, arena upgrade): reward is now PURE ROI — the old
// formula (profitUsd * 100 * (1+ROI) / (1+hh)) scaled with position SIZE, so
// Q-values reflected capital allocation, not strategy quality. A 50% ROI in 1h
// now scores ~3333 whether the position was $0.10 or $10. Q-values are comparable
// across the 16-wallet heterogeneous fleet. QGRID_VER bumped to 5 for clean reset.
// #7 HEARTBEAT helper: base points per trade, scaled by market flow volume.
// ctx.volumeStats = { buyVol, sellVol } in USD (from swap flow). More flow = higher multiplier.
// Rewards keeping the market alive; profit remains the main driver.
function heartbeatPts(ctx) {
  let mult = 1;
  try {
    const vs = ctx && ctx.volumeStats;
    if (vs) {
      const flow = (vs.buyVol || 0) + (vs.sellVol || 0);
      if (flow >= HEARTBEAT_HIGH_FLOW_USD) mult = 3;
      else if (flow >= HEARTBEAT_MED_FLOW_USD) mult = 2;
    }
  } catch (e) { /* fail-soft: 1x */ }
  return HEARTBEAT_BASE_PTS * mult;
}
// A 20% ROI in 0.5h scores ~1333; a 10% ROI in 0.03h scores ~970. The 1.5x-gas hard
// gate remains the floor.
// (review 2026-10-08) Losses are NOT time-discounted any more. Dividing a negative ROI
// by (1+hours) made a -30% loss held 10h score -273 vs -2000 for the same loss cut in
// 30 min — the bandit was being paid to hold losers. Time only discounts gains.
function closeReward(roi, holdHours) {
  const hh = Math.max(holdHours, 1 / 3600);
  return Math.round(roi >= 0 ? (roi * 10000) / (1 + hh) : roi * 10000);
}
async function recordClose(env, i, position, o, log) {
  const { profitUsd, sellGasUsd, costUsd, costGasUsd, holdHours, hash, reason, estimated,
    firstOutBonus, heartbeatBonus } = o;
  const totalCost = costUsd + costGasUsd;
  const roi = totalCost > 0 ? profitUsd / totalCost : 0;
  const hh = Math.max(holdHours, 1 / 3600); // >= 1s epsilon, no div-by-zero on instant flips
  const gasThreshold = SELL_PROFIT_MULT * (costGasUsd + sellGasUsd);
  // (2026-10-08: points-vs-P&L dominance fix) the Q-table learns ONLY the pure
  // economic signal. Behavioral shaping (first-out bonus, holding tax, heartbeat)
  // goes to `reward` → points/leaderboard/exploration, NEVER to Q. Previously a
  // +500 first-out bonus could flip a -30% ROI loss into a positive Q-update,
  // teaching the bandit that a losing regime was good.
  const baseReward = closeReward(roi, hh);
  let reward = baseReward;

  // #4 FIRST-OUT BONUS (2026-10-07 23:05 EDT): broke the standoff when crowded.
  // Passed in via o.firstOutBonus by executeSell (computed pre-close from fleet state).
  if (firstOutBonus > 0) {
    reward += firstOutBonus;
    log(`FIRST-OUT BONUS: +${firstOutBonus}pts (sold first while fleet crowded)`);
  }

  // #5 HOLDING TAX (2026-10-07 23:05 EDT, 15min 2026-10-07 23:33 EDT): every 15min held with <1% price move
  // bleeds 10pts. Sitting still is not free — forces action, breaks standoffs.
  // Flatness measured by |ROI| (realized return ~ price move net of gas).
  let holdingTax = 0;
  const quarters = hh * 4;
  if (quarters >= 1 && Math.abs(roi) * 100 < HOLDING_TAX_FLAT_PCT) {
    holdingTax = Math.floor(quarters) * HOLDING_TAX_PER_15MIN;
    reward -= holdingTax;
    log(`HOLDING TAX: -${holdingTax}pts (${Math.floor(quarters)}x15min held, |ROI| ${(Math.abs(roi) * 100).toFixed(2)}% < ${HOLDING_TAX_FLAT_PCT}%)`);
  }

  // #7 HEARTBEAT (Anthony 2026-10-08 00:58 EDT): +pts for trading (keeping the market alive).
  // Passed in via o.heartbeatBonus by executeSell (computed from ctx flow). Scales with volume.
  if (heartbeatBonus > 0) {
    reward += heartbeatBonus;
    log(`HEARTBEAT: +${heartbeatBonus}pts (trade kept the market alive)`);
  }

  const qtable = (await kvGet(env, `wallet:${i}:qtable`)) || blankQTable();
  const ck = position.comboKey;
  // Orphan positions have no attributable combo (the firing combo's KV write was
  // lost) — crediting Q['orphan_0_0_0'] would plant a dead key that parseCombo
  // turns into {dump: NaN,...} and the bandit could then select. Stats below
  // still record the real P&L.
  // (2026-10-07 18:40 EDT: orphan Q-attribution fix.)
  // (2026-10-08: HONEST RE-ATTRIBUTION replaces the skip — the raw orphan key is
  // still NEVER written to the table (poisoning guard stays); the close is credited
  // under the reconstructed regime-at-buy combo, or the visible baseline when
  // reconstruction fails. Q stays learnable: 0/16 wallets would otherwise accrue
  // zero signal forever.)
  let oldQ = 0, newQ = 0, creditedKey = ck;
  if (ck && ck.startsWith('orphan')) {
    const seed = (await kvGet(env, `wallet:${i}:seed`, null)) || {};
    const creditKey = await reconstructBuyCombo(env, o.publicClient, position, seed, log)
      .catch(() => BASELINE_UNATTRIBUTED_KEY);
    creditedKey = creditKey;
    oldQ = qtable[creditKey] ?? 0;
    newQ = oldQ + ALPHA * (baseReward - oldQ);
    qtable[creditKey] = newQ;
    await kvPut(env, `wallet:${i}:qtable`, qtable);
    log(`orphan close: Q credited under ${creditKey} — ${oldQ.toFixed(2)} -> ${newQ.toFixed(2)} (base ${baseReward}, shaped ${reward})`);
  } else {
    oldQ = qtable[ck] ?? 0;
    newQ = oldQ + ALPHA * (baseReward - oldQ);
    qtable[ck] = newQ;
    await kvPut(env, `wallet:${i}:qtable`, qtable);
  }

  // ---- NN online training: one SGD step per head, on the RIGHT features ----
  // ROI-aware targets (Anthony 2026-10-07 15:25): 20% ROI is the "good trade" bar.
  // tBuy: 1 if ROI >= 20%, scaled ROI/0.20 below that, 0 on loss.
  // tSell: 1 if exit cleared the 1.5x bar AND ROI >= 20%, 0.5 if profitable but
  //   below either, 0 on loss. tSize: reinforce the used size (unchanged).
  // (2026-10-08: train/serve skew fix) the buy/size heads train on BUY-time
  // features (nn:pending:{i}, snapshotted by the buy gate); the sell head trains
  // on HOLDING-time features (nn:sellfeat:{i}, snapshotted by the per-tick sell
  // scorer). Previously all three heads trained on buy-time features while the
  // sell head inferred on holding-time features — a real train/serve skew.
  try {
    const pending = await kvGet(env, nnPendingKey(i), null);
    const rngS = (await kvGet(env, `wallet:${i}:rng`)) || { s: (SEED_BASE + i * SEED_STEP) >>> 0 };
    const nnw = await nnLoad(env, i, rngS);
    if (pending && pending.features && pending.features.length === NN_IN) {
      const fwd = nnForward(nnw, pending.features);
      const tBuy = profitUsd <= 0 ? 0 : (roi >= 0.20 ? 1 : Math.max(0, Math.min(1, roi / 0.20)));
      // (review) The old target echoed the size that was used, win or lose — the size
      // head could only learn to imitate itself. Now: winners nudge size up 10 points,
      // losers nudge it down 10. Still crude, but it is an actual learning signal.
      const usedSize = pending.buySizePct || 70;
      const tSizePct = Math.max(10, Math.min(100, usedSize + (profitUsd > 0 ? 10 : -10)));
      const tSize = (tSizePct - 10) / 90;
      nnTrain(nnw, fwd.cache, [tBuy, tSize, 0], [1, 1, 0]);
      log(`NN trained buy/size heads on buy-time features: buy->${tBuy.toFixed(2)} size->${tSize.toFixed(2)}`);
    }
    const pendingSell = await kvGet(env, `nn:sellfeat:${i}`, null);
    if (pendingSell && pendingSell.features && pendingSell.features.length === NN_IN) {
      const fwdS = nnForward(nnw, pendingSell.features);
      const tSell = profitUsd <= 0 ? 0 : ((profitUsd >= gasThreshold && roi >= 0.20) ? 1 : 0.5);
      nnTrain(nnw, fwdS.cache, [0, 0, tSell], [0, 0, 1]);
      log(`NN trained sell head on holding-time features: sell->${tSell.toFixed(2)} (ROI ${(roi * 100).toFixed(1)}%)`);
    }
    // (review) count training closes; the NN only gets authority after NN_MIN_TRAINED.
    if (pending || pendingSell) nnw.nTrained = (nnw.nTrained || 0) + 1;
    await nnSave(env, i, nnw);
    await kvPut(env, nnPendingKey(i), null); // consume
    await kvPut(env, `nn:sellfeat:${i}`, null); // consume
  } catch (e) {
    log(`NN train failed (${e.message}) — bandit Q-update still applied`);
  }

  // ---- First-class ROI facts (Anthony 2026-10-07 15:25) ----
  const stats = (await kvGet(env, `wallet:${i}:stats`)) || { points: 0, trades: 0, wins: 0, losses: 0, pnlUsd: 0, rewards: [] };
  stats.points += reward;
  stats.trades += 1;
  stats.pnlUsd += profitUsd;
  // (review 2026-10-08) win/loss and the tilt streak are judged on REAL P&L, not on
  // the shaped reward — a -$0.01 trade plus a +5 heartbeat used to count as a "win",
  // which corrupted F[41] win rate and F[42] tilt.
  if (profitUsd > 0) stats.wins += 1; else stats.losses += 1;
  // Self-awareness bookkeeping (2026-10-07 23:41 EDT, trader-needs audit F[42]/F[43]):
  // streak = consecutive losses (tilt detector), peakPoints = high-water mark (drawdown).
  if (profitUsd > 0) { stats.streak = 0; } else { stats.streak = (stats.streak || 0) + 1; }
  stats.pnlHistory = [...(stats.pnlHistory || []), profitUsd].slice(-20);
  stats.peakPoints = Math.max(stats.peakPoints || 0, stats.points);
  stats.rewards.push(reward);
  if (stats.rewards.length > 20) stats.rewards.shift();
  stats.totalBuyCostUsd = (stats.totalBuyCostUsd || 0) + totalCost;
  stats.totalHoldHours = (stats.totalHoldHours || 0) + hh;
  stats.avgRoi = stats.totalBuyCostUsd > 0 ? stats.pnlUsd / stats.totalBuyCostUsd : 0;
  stats.profitPerHourUsd = stats.totalHoldHours > 0 ? stats.pnlUsd / stats.totalHoldHours : 0;
  stats.avgHoldMin = stats.trades > 0 ? (stats.totalHoldHours / stats.trades) * 60 : 0;
  stats.bestRoi = Math.max(stats.bestRoi ?? -Infinity, roi);
  await kvPut(env, `wallet:${i}:stats`, stats);

  // ---- Fleet sell log (arena opponent-awareness, 2026-10-07 22:00 EDT) ----
  // Append this close to the fleet-wide sell log so the next tick's fleet stats
  // can compute recent_fleet_sells (sell pressure). Prune to 15 min on write.
  try {
    const sellLog = (await kvGet(env, 'fleet:sellLog', [])) || [];
    const cutoff = Date.now() - 15 * 60e3;
    const pruned = sellLog.filter((ts) => ts > cutoff);
    pruned.push(Date.now());
    await kvPut(env, 'fleet:sellLog', pruned);
  } catch (e) { /* sell log is advisory — never block the close */ }

  // ---- #8 Adaptive exploration tracking (2026-10-07 23:05 EDT) ----
  // Rolling avg of the last 50 rewards across the fleet. Drives dynamic epsilon
  // in selectCombo: flatline (<10) -> explore more; learning well (>100) -> exploit.
  try {
    const recent = (await kvGet(env, 'arena:recentRewards', [])) || [];
    recent.push(reward);
    if (recent.length > 50) recent.splice(0, recent.length - 50);
    await kvPut(env, 'arena:recentRewards', recent);
    const avgR = recent.reduce((a, b) => a + b, 0) / recent.length;
    await kvPut(env, 'arena:avgReward', avgR);
  } catch (e) { /* exploration tracking is advisory */ }

  return { profitUsd, reward, roi, stats, oldQ, newQ, ck, creditedKey, gasThreshold };
}

// ------------------------------------------------------------------ sell ---
async function executeSell(ctx, i, position, reason, log, fraction = 1.0) {
  const { env, publicClient, ethUsd, dryRun } = ctx;
  const addr = BURNERS[i];

  const bal = await publicClient.readContract({
    address: BRAWL, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr],
  });
  if (bal === 0n) {
    log('position record exists but BRAWL balance is 0 — clearing stale position');
    await kvPut(env, `wallet:${i}:position`, null);
    return null;
  }

  // Partial-sale sizing (Anthony 2026-10-07 15:23): on big positions take a
  // tranche and keep a runner. Integer math only — no float wei.
  //
  // WHALE SAFEGUARD (Anthony 2026-10-07 23:35 EDT, loosened 23:38 EDT): w0 holds 55% of supply.
  // Anthony: "slippage of price crashing is fine... thats kinda going to happen on most coins"
  // Don't over-protect. Cap only at extreme impact (>10x = ~20% slippage). Let them learn.
  // Real traders deal with slippage. If w0 dumps and crashes it, that's the lesson.
  let effFraction = fraction;
  try {
    const priceWeth = ctx.priceWeth;
    const depth2pct = ctx.depth2pctWeth;
    if (priceWeth && depth2pct && depth2pct > 0) {
      const posWeth = (Number(bal) / 1e18) * priceWeth;
      const impact = posWeth / depth2pct; // 1.0 = 2% slippage on full exit
      if (impact > 10.0) {
        const maxFrac = 10.0 / impact;
        if (effFraction > maxFrac) {
          log(`WHALE SAFEGUARD: capping sell ${(effFraction*100).toFixed(0)}% → ${(maxFrac*100).toFixed(0)}% (impact ${impact.toFixed(1)}x would cause ~${(impact*2).toFixed(0)}% slippage)`);
          effFraction = maxFrac;
        }
      }
    }
  } catch (e) { /* safeguard is advisory; never block a sell on error */ }
  const fracBps = Math.max(1, Math.min(10000, Math.round(effFraction * 10000)));
  const sellWei = fracBps >= 10000 ? bal : (bal * BigInt(fracBps)) / 10000n;
  if (sellWei === 0n) { log('sell amount rounds to zero — skip'); return null; }
  const frac = Number(sellWei) / Number(bal); // realized fraction, USD math only

  let q = await getQuote(env, {
    tokenIn: { type: 'erc20', address: BRAWL },
    tokenOut: { type: 'eth' },
    amountInWei: sellWei, sender: addr, log,
  });
  const account = privateKeyToAccount(env[`BURNER_KEY_${i}`]);
  // Permit2: the quote's sell calldata carries a REPLACE_WITH_PERMIT_SIGNATURE placeholder.
  // Sign EIP-712 PermitSingle and re-quote so the API returns final executable calldata.
  q = await resolveSellPermits(env, publicClient, account, q, sellWei, log);
  const target = q.call.target;
  log(`sell quote: target=${target} amountOut=${formatEther(BigInt(q.quote.amountOut))} ETH`);

  // Gas estimate for profitability math (before approval txs muddy it).
  const estGas = await publicClient.estimateGas({
    account: addr, to: target, data: q.call.data, value: 0n,
  }).catch(() => 300000n);
  const gasPrice = await publicClient.getGasPrice();
  const sellGasUsdEst = Number(formatEther(estGas * gasPrice)) * ethUsd;
  const sellValueUsdEst = Number(formatEther(BigInt(q.quote.amountOut))) * ethUsd;
  // Realized portion only: scale cost basis by the fraction actually sold.
  const costUsd = position.buyCostUsd * frac;
  const costGasUsd = position.buyGasUsd * frac;
  const profitEst = sellValueUsdEst - costUsd - costGasUsd - sellGasUsdEst;
  log(`profit est: sell $${sellValueUsdEst.toFixed(4)} - buy $${costUsd.toFixed(4)} - buyGas $${costGasUsd.toFixed(4)} - sellGas $${sellGasUsdEst.toFixed(4)} = $${profitEst.toFixed(4)}${frac < 1 ? ` (${(frac * 100).toFixed(0)}% tranche)` : ''}`);

  // CORE RULE (Anthony 2026-10-07): the sale itself must clear 1.5x ITS gas cost.
  // profit = sell - frac*buy - frac*buyGas - sellGas must clear 1.5 * (frac*buyGas + sellGas).
  // Exempt reasons: 'stop-loss' and 'max-hold' knowingly exit at a loss — the 1.5x gate
  // is INTENTIONALLY bypassed for them (deadlock breakers: an underwater wallet that
  // can never sell can never learn). Stop-loss is the precedent.
  const totalGasUsd = costGasUsd + sellGasUsdEst;
  const minProfit = SELL_PROFIT_MULT * totalGasUsd;
  if (profitEst < minProfit && reason !== 'stop-loss' && reason !== 'max-hold') {
    log(`SKIP sell (${reason}): profit $${profitEst.toFixed(4)} < 1.5x gas ($${minProfit.toFixed(4)})`);
    return null;
  }

  await ensureSellApproval(publicClient, account, target, sellWei, env, log, dryRun, ctx.signal);
  if (dryRun) { log('DRY_RUN: skip sell broadcast'); return null; }

  const ethBefore = await publicClient.getBalance({ address: addr });
  const { hash, gasPrice: gp } = await sendRawTx(publicClient, account, {
    to: target, data: q.call.data, value: 0n,
  }, log, { signal: ctx.signal });
  // Receipt poll with balance-delta fallback (publicnode archive bug can kill
  // eth_getTransactionReceipt; never leave a ghost position or drop a profit).
  let rc = null;
  try {
    rc = await waitReceipt(publicClient, hash, log);
    if (rc && rc.status !== '0x1') throw new Error(`sell reverted: ${hash}`);
    if (!rc) throw new Error('receipt unavailable — balance-delta fallback');
  } catch (e) {
    if (!String(e.message || '').startsWith('sell reverted')) {
      log(`waitReceipt failed (${String(e.message).slice(0, 80)}) — balance-delta fallback`);
      // Retry the balance check: the tx often lands 10-40s after the receipt
      // poll gives up (2026-10-07 18:55 EDT: 11 spike-sells declared dead then
      // confirmed onchain seconds later — dropped P&L across the fleet).
      let balCheck = 0n, confirmed = false;
      const expectedMax = bal - sellWei + sellWei / 100n; // partial-aware, 1% tolerance
      for (let attempt = 0; attempt < 6; attempt++) {
        balCheck = await publicClient.readContract({
          address: BRAWL, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr],
        }).catch(() => bal);
        if (balCheck <= expectedMax) { confirmed = true; break; }
        if (attempt < 5) await new Promise((r) => setTimeout(r, 10000));
      }
      if (!confirmed) throw new Error(`sell unconfirmed after 60s: no receipt and balance ${balCheck} wei > expected ${expectedMax} wei`);
      log(`RECEIPT-FALLBACK: sell confirmed via balance delta (now ${balCheck} wei), proceeding without receipt`);
    } else throw e;
  }
  const ethAfter = await publicClient.getBalance({ address: addr });
  const gasUsedFallback = rc ? BigInt(rc.gasUsed) : estGas;
  const sellGasUsd = txCostUsd(gasUsedFallback, gp, ethUsd);
  // Actual received = ETH balance delta minus the sell tx's own gas (already out of ethAfter).
  // ethAfter = ethBefore - sellGas + sellValue  =>  sellValue = ethAfter - ethBefore + sellGas
  const sellValueUsd = (Number(formatEther(ethAfter - ethBefore)) * ethUsd) + sellGasUsd;
  // Realized portion only (fraction-scaled cost basis).
  const profitUsd = sellValueUsd - costUsd - costGasUsd - sellGasUsd;

  const sellTs = Date.now();
  const holdHours = (sellTs - position.buyTs) / 3600000;
  // #4 FIRST-OUT BONUS (2026-10-07 23:05 EDT): if fleet crowdedness > 0.9 and
  // no sells in the last 30 min, this wallet is breaking the Mexican standoff.
  // Computed pre-close (this sell hasn't hit fleet:sellLog yet, so 0 recent = first).
  let firstOutBonus = 0;
  try {
    const crowded = ctx.fleet ? (ctx.fleet.holdingCount / 16) : 0;
    if (crowded > FIRST_OUT_CROWD_THRESH) {
      const sellLog = (await kvGet(env, 'fleet:sellLog', [])) || [];
      const cutoff30 = sellTs - FIRST_OUT_WINDOW_MS;
      const recentSells30 = sellLog.filter((ts) => ts > cutoff30).length;
      if (recentSells30 === 0) {
        // Proportional: sell 50% = 250pts, sell 100% = 500pts. Partial exits count. (Anthony 2026-10-07 23:33 EDT)
        firstOutBonus = Math.round(FIRST_OUT_BONUS * fraction);
        log(`FIRST-OUT: crowdedness ${crowded.toFixed(2)} > ${FIRST_OUT_CROWD_THRESH}, first sell in 30m (${(fraction*100).toFixed(0)}% of position) — bonus ${firstOutBonus}pts queued`);
      }
    }
  } catch (e) { /* first-out check is advisory */ }
  const rc0 = await recordClose(env, i, position, {
    profitUsd, sellGasUsd, costUsd, costGasUsd, holdHours, hash, reason, firstOutBonus,
    heartbeatBonus: heartbeatPts(ctx), publicClient,
  }, log);
  const { reward, roi, stats, oldQ, creditedKey } = rc0;
  const newQ = rc0.newQ;
  // ---- Deferred ruthlessness scoring (2026-10-07 23:05 EDT, superintelligence #1/#2/#3) ----
  // Store sell context; runTick's scorePendingSells() evaluates 10 min later:
  //   #1 top-tick: price dropped >=5% after sell -> +dropPct*500
  //   #2 loss-cut: sold at loss, price dropped further -> +dropPct*300
  //   #3 FOMO: someone bought within 2 min at higher price -> +200
  try {
    await kvPut(env, `wallet:${i}:pendingSell`, {
      sellTs, sellSq: ctx.nowSq.toString(), roi, reason, scored: false,
    });
  } catch (e) { /* deferred scoring is advisory */ }
  // Swing-cycle (2026-10-07 23:37 EDT): remember this sell's price. When the
  // wallet buys back in lower, executeBuy awards the SWING BONUS. Overwrites on
  // every sell — the most recent exit is the re-entry benchmark.
  try {
    await kvPut(env, `wallet:${i}:lastSell`, { ts: sellTs, sq: ctx.nowSq.toString() });
  } catch (e) { /* lastSell is advisory — never block the sell */ }

  // Runner accounting (Anthony 2026-10-07 15:23): on a partial sale, keep the
  // remainder with proportionally scaled cost basis — it keeps trailing/stop-loss
  // logic on later ticks. Dust remainder (<$0.01 est. value) closes fully.
  const runnerWei = await publicClient.readContract({
    address: BRAWL, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr],
  }).catch(() => 0n);
  if (fracBps >= 10000 || runnerWei === 0n) {
    await kvPut(env, `wallet:${i}:position`, null);
    log(`SOLD (${reason}) 100%: profit $${profitUsd.toFixed(4)} ROI ${(roi * 100).toFixed(1)}% (${reward}pts) | Q[${creditedKey}] ${oldQ.toFixed(2)} -> ${newQ.toFixed(2)} | tx ${hash} | avgROI ${(stats.avgRoi * 100).toFixed(1)}% $/h $${stats.profitPerHourUsd.toFixed(2)} | wallet points now ${stats.points}`);
  } else {
    const runnerFrac = Number(runnerWei) / Number(bal);
    const runnerValueUsd = sellValueUsd * runnerFrac; // proportional estimate
    if (runnerValueUsd < RUNNER_DUST_USD) {
      await kvPut(env, `wallet:${i}:position`, null);
      log(`SOLD (${reason}): runner dust ($${runnerValueUsd.toFixed(4)}) — closed fully | profit $${profitUsd.toFixed(4)} ROI ${(roi * 100).toFixed(1)}% (${reward}pts) | tx ${hash} | avgROI ${(stats.avgRoi * 100).toFixed(1)}% $/h $${stats.profitPerHourUsd.toFixed(2)}`);
    } else {
      const runnerPos = {
        ...position,
        amountWei: runnerWei.toString(),
        buyCostUsd: position.buyCostUsd * runnerFrac,
        buyGasUsd: position.buyGasUsd * runnerFrac,
        buyTx: hash, // latest touch; buyTs keeps original age for stop-loss clock
        ethBalPostBuy: ethAfter.toString(), // re-baseline: partial proceeds already in ethAfter
      };
      await kvPut(env, `wallet:${i}:position`, runnerPos);
      log(`SOLD (${reason}) ${(frac * 100).toFixed(0)}% tranche: profit $${profitUsd.toFixed(4)} ROI ${(roi * 100).toFixed(1)}% (${reward}pts) | runner ${formatEther(runnerWei)} BRAWL (cost $${runnerPos.buyCostUsd.toFixed(4)}) | tx ${hash} | avgROI ${(stats.avgRoi * 100).toFixed(1)}% $/h $${stats.profitPerHourUsd.toFixed(2)} | wallet points now ${stats.points}`);
    }
  }
  await kvPut(env, `wallet:${i}:lastTrade`, Date.now());
  return { profitUsd, reward, fraction: frac };
}

// ------------------------------------------------------------------ ruthlessness scoring ---
// Deferred bonuses (2026-10-07 23:05 EDT, superintelligence #1/#2/#3).
// Called once per tick in runTick. For each wallet with an unscored pendingSell
// older than 10 min, evaluates:
//   #1 TOP-TICK: price dropped >=5% since the sell -> bonus = dropPct * 500.
//        You called the top. Ruthless and right.
//   #2 LOSS-CUT: sold at a loss (roi < 0) and price dropped further ->
//        bonus = dropPct * 300. Cutting losers early is discipline.
//   #3 FOMO-EXPLOIT: another wallet bought within 2 min after your sell at a
//        HIGHER price -> bonus = 200. You sold into their FOMO. Predatory.
// Bonuses go straight to stats.points (not the Q-table — they're post-hoc style
// rewards, not attributable to the entry combo).
async function scorePendingSells(env, nowSq, log) {
  if (!nowSq || nowSq <= 0n) return;
  const now = Date.now();
  for (let i = 0; i < BURNERS.length; i++) {
    let pending = null;
    try { pending = await kvGet(env, `wallet:${i}:pendingSell`, null); } catch (e) { continue; }
    if (!pending || pending.scored) continue;
    if (now - pending.sellTs < TOP_TICK_WINDOW_MS) continue; // not ripe yet
    try {
      const sellSq = BigInt(pending.sellSq);
      const sN = Number(sellSq), nN = Number(nowSq);
      let totalBonus = 0;
      const parts = [];
      // #1 + #2: price drop since sell
      if (nN < sN) {
        const dropPct = ((sN - nN) / sN) * 100;
        if (dropPct >= TOP_TICK_DROP_PCT) {
          const b = Math.round(dropPct * TOP_TICK_BONUS_PER_PCT);
          totalBonus += b;
          parts.push(`TOP-TICK +${b} (${dropPct.toFixed(1)}% drop in 10m)`);
        }
        if (pending.roi < 0 && dropPct > 0) {
          const b = Math.round(dropPct * LOSS_CUT_BONUS_PER_PCT);
          totalBonus += b;
          parts.push(`LOSS-CUT +${b} (sold at ${(pending.roi * 100).toFixed(1)}%, dropped ${dropPct.toFixed(1)}% more)`);
        }
      }
      // #3: FOMO — did anyone buy within 2 min after this sell at a higher price?
      try {
        const buyLog = (await kvGet(env, 'fleet:buyLog', [])) || [];
        const fomoBuy = buyLog.find((b) =>
          b.ts > pending.sellTs &&
          b.ts <= pending.sellTs + FOMO_WINDOW_MS &&
          b.walletIdx !== i &&
          BigInt(b.priceSq) > sellSq
        );
        if (fomoBuy) {
          totalBonus += FOMO_BONUS;
          parts.push(`FOMO-EXPLOIT +${FOMO_BONUS} (w${fomoBuy.walletIdx} bought higher within 2m)`);
        }
      } catch (e) { /* FOMO check advisory */ }
      if (totalBonus > 0) {
        const stats = (await kvGet(env, `wallet:${i}:stats`, null)) || { points: 0 };
        stats.points = (stats.points || 0) + totalBonus;
        await kvPut(env, `wallet:${i}:stats`, stats);
        log(`[w${i}] RUTHLESSNESS BONUS +${totalBonus}pts: ${parts.join('; ')}`);
      } else {
        log(`[w${i}] pending sell scored: no ruthlessness bonus (price held)`);
      }
      pending.scored = true;
      await kvPut(env, `wallet:${i}:pendingSell`, pending);
    } catch (e) {
      log(`[w${i}] pending-sell scoring failed (${e.message}) — marking scored to avoid retry loop`);
      try { pending.scored = true; await kvPut(env, `wallet:${i}:pendingSell`, pending); } catch (e2) {}
    }
  }
}

// ------------------------------------------------------------------ cash drag ---
// Swing-cycle (2026-10-07 23:37 EDT): sitting in cash during a rally bleeds.
// If a wallet has NO position, HAS traded before, and BRAWL is up 5%+ in the
// last hour — it's missing the move. -50pts per application, max once per wallet
// per 15 min (per-wallet cooldown prevents -50/min runaway while the rally holds).
// Teaches: stay invested in uptrends, don't sit flat after selling the bottom.
const CASH_DRAG_PENALTY = 50;
const CASH_DRAG_RALLY_PCT = 5;
const CASH_DRAG_COOLDOWN_MS = 15 * 60e3;
async function applyCashDrag(env, buckets, nowSq, now, log) {
  if (!nowSq || nowSq <= 0n || !buckets || buckets.length === 0) return;
  // Price ~1h ago from bucket history.
  const t1h = now - 3600e3;
  let sq1h = null;
  for (let k = buckets.length - 1; k >= 0; k--) {
    if (buckets[k].ts <= t1h) { sq1h = buckets[k].sq; break; }
  }
  if (!sq1h || sq1h <= 0n) return; // no 1h history yet — can't judge the rally
  const nN = Number(nowSq), hN = Number(sq1h);
  const rallyPct = ((nN - hN) / hN) * 100;
  if (rallyPct < CASH_DRAG_RALLY_PCT) return; // no rally — no drag
  for (let i = 0; i < BURNERS.length; i++) {
    try {
      const position = await kvGet(env, `wallet:${i}:position`, null);
      if (position) continue; // holding — not in cash
      const stats = (await kvGet(env, `wallet:${i}:stats`, null)) || { trades: 0, points: 0 };
      if ((stats.trades || 0) <= 0) continue; // brand new — hasn't learned to trade yet
      const lastDrag = (await kvGet(env, `wallet:${i}:lastCashDrag`, 0)) || 0;
      if (now - lastDrag < CASH_DRAG_COOLDOWN_MS) continue; // cooldown — no runaway
      stats.points = (stats.points || 0) - CASH_DRAG_PENALTY;
      await kvPut(env, `wallet:${i}:stats`, stats);
      await kvPut(env, `wallet:${i}:lastCashDrag`, now);
      log(`[w${i}] CASH DRAG: -${CASH_DRAG_PENALTY}pts (flat during +${rallyPct.toFixed(1)}% 1h rally, ${stats.trades} trades)`);
    } catch (e) { /* cash drag is advisory — never block the tick */ }
  }
}

// ------------------------------------------------------------------ tournament ---
// Zero-sum arena ranking (2026-10-07 23:05 EDT, superintelligence #6).
// Every 24h, rank all 16 by avg ROI. Top 3 get bonuses, bottom 3 get penalties.
// They're not just trading the market — they're trading EACH OTHER.
async function maybeRunTournament(env, log) {
  const now = Date.now();
  const last = (await kvGet(env, 'arena:lastTournament', 0)) || 0;
  if (now - last < TOURNAMENT_INTERVAL_MS) return;
  const rows = [];
  for (let i = 0; i < BURNERS.length; i++) {
    const st = (await kvGet(env, `wallet:${i}:stats`, null)) || {};
    rows.push({ i, avgRoi: st.avgRoi || 0, trades: st.trades || 0, points: st.points || 0 });
  }
  rows.sort((a, b) => b.avgRoi - a.avgRoi);
  const applied = [];
  for (let rank = 0; rank < 3 && rank < rows.length; rank++) {
    const r = rows[rank];
    const bonus = TOURNAMENT_TOP_BONUS[rank];
    const st = (await kvGet(env, `wallet:${r.i}:stats`, null)) || { points: 0 };
    st.points = (st.points || 0) + bonus;
    await kvPut(env, `wallet:${r.i}:stats`, st);
    applied.push(`w${r.i} #${rank + 1} +${bonus}`);
  }
  for (let k = 0; k < 3 && k < rows.length; k++) {
    const r = rows[rows.length - 1 - k];
    // Don't penalize wallets that never traded (no data, not failure).
    if (r.trades === 0) continue;
    const penalty = TOURNAMENT_BOT_PENALTY[k];
    const st = (await kvGet(env, `wallet:${r.i}:stats`, null)) || { points: 0 };
    st.points = (st.points || 0) - penalty;
    await kvPut(env, `wallet:${r.i}:stats`, st);
    applied.push(`w${r.i} #${rows.length - k} -${penalty}`);
  }
  const board = rows.map((r, idx) => `#${idx + 1} w${r.i} ${(r.avgRoi * 100).toFixed(1)}%`).join(' | ');
  log(`TOURNAMENT (24h): ${applied.join(', ')} || ${board}`);
  await kvPut(env, 'arena:lastTournament', now);
}

// ------------------------------------------------------------------ per-wallet tick ---
async function processWallet(ctx, i, log0) {
  const { env, publicClient, ethUsd, nowSq, priceWeth, highSq, low24Sq, prevSq, moveBps, now } = ctx;
  const log = (m) => log0(`[w${i}] ${m}`);
  const addr = BURNERS[i];

  // NEVER BE BLIND: if data quality is too low, DO NOT TRADE (Anthony 2026-10-08 00:17 EDT).
  // This is a safety rail, not paternalism — trading on bad data is not "learning",
  // it's gambling. The NN sees F[45] and learns the pattern; this gate is the backstop.
  if (ctx.dataQuality != null && ctx.dataQuality < 0.6) {
    log(`DATA QUALITY ${(ctx.dataQuality*100).toFixed(0)}% < 60% — SKIPPING (blind, do not trade)`);
    return { skipped: 'blind' };
  }

  // Load state (defaults for first run).
  let seed = await kvGet(env, `wallet:${i}:seed`);
  if (!seed) {
    const sp = seedParams(i);
    seed = { dip: sp.dip, margin: sp.margin, size: sp.size, cooldownMin: sp.cooldownMin };
    await kvPut(env, `wallet:${i}:seed`, seed);
    await kvPut(env, `wallet:${i}:rng`, sp.rngState);
    await kvPut(env, `wallet:${i}:qtable`, blankQTable());
    await kvPut(env, `wallet:${i}:stats`, { points: 0, trades: 0, wins: 0, losses: 0, pnlUsd: 0, rewards: [] });
    log(`seeded: dip=${seed.dip.toFixed(1)}% margin=${seed.margin.toFixed(1)}% size=${seed.size.toFixed(0)}% cooldown=${seed.cooldownMin.toFixed(0)}m`);
  }
  let rngState = (await kvGet(env, `wallet:${i}:rng`)) || { s: (SEED_BASE + i * SEED_STEP) >>> 0 };
  let position = await kvGet(env, `wallet:${i}:position`, null);

  // Orphan-position reconciliation (Anthony 2026-10-07 14:39): a failed receipt poll
  // can leave an onchain BRAWL balance with no KV record. The bot must NEVER sit
  // flat on real tokens. Reconstruct conservatively — cost basis = current estimated
  // sell value — so it only sells once price has risen enough to clear 1.5x gas
  // from the reconciliation point. Safe: no double-buys (holding branch entered),
  // no forced loss (cost basis can't be below what we can currently get).
  if (!position) {
    const orphanBal = await publicClient.readContract({
      address: BRAWL, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr],
    }).catch(() => 0n);
    if (orphanBal > 0n) {
      log(`ORPHAN POSITION: holding ${formatEther(orphanBal)} BRAWL with no KV record — reconstructing`);
      let orphanValueUsd = 0;
      try {
        const oq = await getQuote(env, {
          tokenIn: { type: 'erc20', address: BRAWL }, tokenOut: { type: 'eth' },
          amountInWei: orphanBal, sender: addr, log,
        });
        orphanValueUsd = Number(formatEther(BigInt(oq.quote.amountOut))) * ethUsd;
      } catch (e) { log(`orphan sell-quote failed (${e.message}) — will retry quote next tick`); }
      // (review) If executeBuy left a write-ahead record, this "orphan" is really our
      // own buy whose position write failed — keep its TRUE combo key and buy time.
      const wal = await kvGet(env, `wallet:${i}:pendingBuy`, null);
      const walOk = wal && wal.comboKey && (now - wal.ts) < 24 * 3600e3 && (wal.comboKey in blankQTable());
      if (walOk) log(`orphan matches write-ahead buy record (combo ${wal.comboKey}) — attribution preserved`);
      if (orphanValueUsd > 0) {
        // Snapshot current ETH as the stale-clear reconstruction baseline
        // (2026-10-07 18:52 EDT: w0's spike-sell confirmed 40s after the receipt
        // race declared it dead; without a baseline the P&L was dropped).
        const ethNow = await publicClient.getBalance({ address: addr }).catch(() => 0n);
        position = {
          buyCostUsd: orphanValueUsd, buyGasUsd: 0,
          amountWei: orphanBal.toString(), buyPriceWeth: null,
          comboKey: walOk ? wal.comboKey : 'orphan_0_0_0', marginAtOpen: walOk ? parseCombo(wal.comboKey).margin : 3,
          sizeAtOpen: walOk ? wal.sizePct : 0,
          buyTx: 'orphan-reconcile', buyTs: walOk ? wal.ts : now, reconciled: true,
          ethBalPostBuy: ethNow.toString(),
        };
        await kvPutCritical(env, `wallet:${i}:position`, position, log);
        if (walOk) await kvPut(env, `wallet:${i}:pendingBuy`, null);
        log(`reconciled: cost basis = current sell value $${orphanValueUsd.toFixed(4)} (flagged reconciled)`);
      } else {
        // Quote failed but we HOLD tokens — never leave position null. Record the
        // holding with zero basis so the bot manages (not re-buys) it; a later tick
        // with a working quote will refine the basis. (2026-10-07 16:15)
        position = {
          buyCostUsd: 0, buyGasUsd: 0,
          amountWei: orphanBal.toString(), buyPriceWeth: null,
          comboKey: 'orphan_0_0_0', marginAtOpen: 3, sizeAtOpen: 0,
          buyTx: 'orphan-reconcile-noquote', buyTs: now, reconciled: true, quoteFailed: true,
        };
        await kvPutCritical(env, `wallet:${i}:position`, position, log);
        log(`ORPHAN RECORDED WITHOUT QUOTE — manual review advised, basis $0`);
      }
    }
  }
  const lastTrade = (await kvGet(env, `wallet:${i}:lastTrade`, 0));
  // Swing-cycle: last sell context for F[38] time-since-sell and the swing bonus.
  // (2026-10-07 23:37 EDT) — teaches re-entry: "I sold at $X, price is now $Y < $X."
  const lastSell = await kvGet(env, `wallet:${i}:lastSell`, null);

  // RL grid versioning: reset stale Q-tables when the grid changes.
  let qtable = await kvGet(env, `wallet:${i}:qtable`, null);
  const qver = await kvGet(env, `wallet:${i}:qgridver`, 0);
  if (!qtable || qver !== QGRID_VER) {
    qtable = blankQTable();
    await kvPut(env, `wallet:${i}:qtable`, qtable);
    await kvPut(env, `wallet:${i}:qgridver`, QGRID_VER);
    log(`Q-table reset to grid v${QGRID_VER} (dump/value thresholds learnable)`);
  } else {
    // One-time in-place migration: 4-dim combos -> 5-dim with learnable cooldown.
    const migrated = migrateQTableCd(qtable, seed.cooldownMin);
    if (migrated !== qtable) {
      qtable = migrated;
      await kvPut(env, `wallet:${i}:qtable`, qtable);
      log(`Q-table migrated to 5-dim (${Object.keys(qtable).length} combos): learned Q kept on nearest-cd variant, other cds start at 0`);
    }
  }
  // In-place baseline upgrade (2026-10-08): tables created before the baseline key
  // get it at 0 WITHOUT resetting learned values. QGRID_VER is deliberately NOT
  // bumped — a bump would wipe all learned Q across the fleet.
  if (!(BASELINE_UNATTRIBUTED_KEY in qtable)) {
    qtable[BASELINE_UNATTRIBUTED_KEY] = 0;
    await kvPut(env, `wallet:${i}:qtable`, qtable);
    log(`Q-table: added ${BASELINE_UNATTRIBUTED_KEY} baseline key (in-place, learned values kept)`);
  }
  // #8 Adaptive exploration (2026-10-07 23:05 EDT): epsilon scales with the
  // fleet's recent learning velocity. Flatline -> explore more (break deadlocks).
  let dynEps = EPSILON;
  try {
    const avgR = await kvGet(env, 'arena:avgReward', null);
    if (avgR != null) {
      if (avgR < 10) dynEps = EPSILON * 2;
      else if (avgR > 100) dynEps = EPSILON * 0.9;
      dynEps = Math.max(EPSILON_MIN, Math.min(EPSILON_MAX, dynEps));
      if (dynEps !== EPSILON) log(`adaptive epsilon: ${dynEps.toFixed(2)} (avgReward ${avgR.toFixed(1)})`);
    }
  } catch (e) { /* adaptive epsilon is advisory — fall back to base */ }
  const ck = selectCombo(qtable, rngState, log, dynEps);
  await kvPut(env, `wallet:${i}:rng`, rngState); // persist advanced RNG state
  const parsed = parseCombo(ck);
  const activeDump = parsed.dump, activeValue = parsed.value, activeMargin = parsed.margin, activeSize = parsed.size;
  const activeCd = clampCd(parsed.cd);

  // Cooldown — LEARNABLE (Anthony 2026-10-07 15:32): the bandit combo carries the
  // cooldown, so the ROI×speed Q-update on every close teaches which re-entry
  // speed pays. Holding wallets are gated by the combo that OPENED the position;
  // flat wallets by the combo selected this tick.
  // (review) The cooldown now gates BUYS only. It used to run before the holding
  // branch too, so for 3-20 min after every buy a wallet could not evaluate ANY exit —
  // not the target, not the stop-loss. A coin that dumped right after entry was
  // unsellable until the timer ran out.
  const gateCd = activeCd;
  const cooldownMs = gateCd * 60 * 1000;
  if (!position && now - lastTrade < cooldownMs) {
    log(`cooldown: ${Math.round((cooldownMs - (now - lastTrade)) / 60000)}m left (cd${gateCd}, combo ${ck}) — skip`);
    return;
  }

  if (position) {
    // ---------------- HOLDING: evaluate exits ----------------

    // 1) Spike exits are handled by the tick-level pre-pass in runTick (immediately, in the
    // same invocation, before the wallet loop) — no per-wallet spike check needed here.
    // If a spike sell was skipped (not profitable), fall through to normal checks.

    // 2) Need a sell quote to evaluate target/stop-loss. Do it inside a helper to avoid
    //    duplicating quote logic: reuse executeSell's pre-check by inlining the math here.
    // 2026-10-08 02:50 EDT (baby-monitor v2 diaper change): a FAILED balance read
    // must NEVER be treated as zero. Degraded RPC (timeouts) funneled through the
    // old `.catch(() => 0n)` and the stale-clear below destroyed LIVE position
    // records — w8–w15 ping-ponged clear/reconstruct 4+ times on 2026-10-08
    // 02:57–06:45 UTC while their onchain balances never moved. Failed read =
    // UNKNOWN = HOLD this tick; only a CONFIRMED 0n may clear.
    let bal = null;
    try {
      bal = await publicClient.readContract({
        address: BRAWL, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr],
      });
    } catch (e) {
      log(`balance read failed (${String((e && e.message) || e).slice(0, 80)}) — HOLD, not clearing (unknown ≠ 0)`);
    }
    if (bal === 0n) {
      // Stale-clear with profit reconstruction (Anthony 2026-10-07 15:25): the
      // position sold onchain but the sale was never recorded (receipt-poll gap).
      // If we have the post-buy ETH baseline, estimate proceeds from the balance
      // delta and record the close with the ROI reward instead of dropping it.
      // Otherwise log the dropped cost basis as UNKNOWN-profit — never pretend
      // nothing happened.
      let staleNote = 'no reconstruction baseline';
      try {
        if (position.ethBalPostBuy != null) {
          const ethNow = await publicClient.getBalance({ address: addr }).catch(() => 0n);
          const ethDelta = ethNow - BigInt(position.ethBalPostBuy);
          if (ethDelta > 0n) {
            const gp0 = await publicClient.getGasPrice().catch(() => 0n);
            const sellGasWei = 300000n * gp0; // estimate; receipt unavailable
            const sellGasUsd0 = Number(formatEther(sellGasWei)) * ethUsd;
            const sellValueUsd0 = Number(formatEther(ethDelta)) * ethUsd + sellGasUsd0;
            const profitUsd0 = sellValueUsd0 - position.buyCostUsd - position.buyGasUsd - sellGasUsd0;
            const holdHours0 = (Date.now() - position.buyTs) / 3600000;
            const rc0 = await recordClose(env, i, position, {
              profitUsd: profitUsd0, sellGasUsd: sellGasUsd0,
              costUsd: position.buyCostUsd, costGasUsd: position.buyGasUsd,
              holdHours: holdHours0, hash: position.buyTx || 'unknown', reason: 'stale-reconstruct',
              publicClient,
            }, log);
            staleNote = `reconstructed ~$${profitUsd0.toFixed(4)} (ROI ${(rc0.roi * 100).toFixed(1)}%, ${rc0.reward}pts, ESTIMATED)`;
          } else {
            staleNote = `UNKNOWN-profit: cost basis $${position.buyCostUsd.toFixed(4)} exited for unknown proceeds (ETH delta <= 0)`;
          }
        }
      } catch (e) { staleNote = `reconstruction failed: ${String(e.message).slice(0, 80)}`; }
      log(`no BRAWL balance — clearing stale position (${staleNote})`);
      await kvPut(env, `wallet:${i}:position`, null);
      return;
    }
    if (bal === null) return; // balance read failed above — can't price exits without a confirmed balance; HOLD this tick
    let profitEst = null;
    let sellGasUsd = 0; // declared OUTSIDE try — exit math below needs it (was a scoping bug: holding branch could never sell)
    let sellValueUsd = 0; // same scoping fix (2026-10-07 16:54: TICK ERROR on w9)
    try {
      const q = await getQuote(env, {
        tokenIn: { type: 'erc20', address: BRAWL }, tokenOut: { type: 'eth' },
        amountInWei: bal, sender: addr, log,
      });
      const estGas = await publicClient.estimateGas({ account: addr, to: q.call.target, data: q.call.data, value: 0n }).catch(() => 300000n);
      const gp = await publicClient.getGasPrice();
      sellValueUsd = Number(formatEther(BigInt(q.quote.amountOut))) * ethUsd;
      sellGasUsd = Number(formatEther(estGas * gp)) * ethUsd;
      profitEst = sellValueUsd - position.buyCostUsd - position.buyGasUsd - sellGasUsd;
      log(`holding ${formatEther(bal)} BRAWL | profitEst $${profitEst.toFixed(4)} (margin target $${(position.buyCostUsd * position.marginAtOpen / 100).toFixed(4)})`);
    } catch (e) {
      log(`sell-quote failed (${e.message}) — HOLD`);
      return;
    }

    // 3) Target exit: profit >= 1.5x total gas (Anthony 2026-10-07 — higher bar).
    const totalGasEst = position.buyGasUsd + sellGasUsd;
    // (review) The MARGIN dimension of the Q grid (1/3/5%) used to do NOTHING — it was
    // only printed. 1/3 of the 432 arms were copies of each other and split the data
    // 3 ways. Now the target is the larger of the gas bar and the combo's margin %.
    const marginUsd = position.buyCostUsd * (Number(position.marginAtOpen) || 0) / 100;
    const minProfit = Math.max(SELL_PROFIT_MULT * totalGasEst, marginUsd);
    if (profitEst >= minProfit) {
      // Tranche logic (Anthony 2026-10-07 15:23): big positions take 50% and keep
      // a runner; small ones dump 100% (an extra sell tx would eat the profit).
      // Dust runner (<$0.01) also goes 100%.
      let sellFrac = 1.0;
      if (sellValueUsd >= PARTIAL_SELL_MIN_USD && sellValueUsd * (1 - PARTIAL_SELL_FRACTION) >= RUNNER_DUST_USD) {
        sellFrac = PARTIAL_SELL_FRACTION;
      }
      log(`TARGET HIT: profit $${profitEst.toFixed(4)} >= max(1.5x gas, margin) $${minProfit.toFixed(4)} — ${sellFrac < 1 ? `taking ${(sellFrac * 100).toFixed(0)}% + runner (sell value $${sellValueUsd.toFixed(2)})` : 'selling ALL'}`);
      await executeSell(ctx, i, position, 'target', log, sellFrac).catch((e) => log(`sell error: ${e.message}`));
      await kvPut(env, `wallet:${i}:rng`, rngState);
      return;
    }

    // 3b) NN early-exit: the net scores every holding tick. If sellScore > 0.70 and
    // profit is positive (even below the 1.5x bar), the NN has learned this pattern
    // usually reverses — take the profit early. v1 advisory; bandit rules still primary.
    try {
      const nnw = await nnLoad(env, i, rngState);
      const ethBalNow = await publicClient.getBalance({ address: addr }).catch(() => 0n);
      const statsNow = (await kvGet(env, `wallet:${i}:stats`, null)) || { points: 0 };
      const feats = buildFeatures({
        buckets: ctx.buckets || [], nowSq, highSq, low24Sq, prevSq,
        moveBps, prevMoveBps: ctx.prevMoveBps, pattern: ctx.pattern,
        ethBal: ethBalNow, brawlBal: bal, position, stats: statsNow,
        gasPriceWei: ctx.gasPriceWei || 0n, ethUsd,
        ethUsdPrev1h: ctx.ethUsdPrev1h, now,
        unrealizedPnlPct: position.buyCostUsd > 0 ? (profitEst / position.buyCostUsd) * 100 : 0,
        fleet: ctx.fleet, walletIdx: i,
        // PLUS ULTRA senses (shared per-tick via ctx)
        volumeStats: ctx.volumeStats, depth2pctWeth: ctx.depth2pctWeth,
        positionWeth: Number(BigInt(position.amountWei)) / 1e18 * priceWeth,
        gasSpike: ctx.gasSpike, whaleNetBrawl: ctx.whaleNetBrawl, priceVelAnn: ctx.priceVelAnn,
        lastSell, // swing-cycle: F[38] time-since-sell
        dataQuality: ctx.dataQuality, // F[45] NEVER BE BLIND
      });
      const { out } = nnForward(nnw, feats);
      const sellScore = out[2];
      log(`NN: sellScore=${sellScore.toFixed(3)} (trigger ${NN_SELL_TRIGGER})`);
      // (2026-10-08: train/serve skew fix) the sell head INFERS on these
      // holding-time features but used to TRAIN on buy-time features. Stash the
      // latest holding-time vector; recordClose trains the sell head on it.
      try { await kvPut(env, `nn:sellfeat:${i}`, { features: feats, ts: now }); } catch (e) { /* advisory */ }
      const nnLive = (nnw.nTrained || 0) >= NN_MIN_TRAINED;
      if (!nnLive) log(`NN not trusted yet (${nnw.nTrained || 0}/${NN_MIN_TRAINED} trained closes) — early-exit disabled`);
      if (nnLive && sellScore > NN_SELL_TRIGGER && profitEst > 0) {
        log(`NN EARLY EXIT: sellScore ${sellScore.toFixed(3)} > ${NN_SELL_TRIGGER}, profit $${profitEst.toFixed(4)} > 0 — selling`);
        await executeSell(ctx, i, position, 'nn-early', log).catch((e) => log(`sell error: ${e.message}`));
        await kvPut(env, `wallet:${i}:rng`, rngState);
        return;
      }
    } catch (e) {
      log(`NN sell-score failed (${e.message}) — continuing with bandit rules`);
    }

    // 4) Stop-loss: per-wallet desync'd threshold (see walletStopLoss) — down X%+
    // and held Yh+ -> sell anyway (RL learns from the negative reward).
    const heldMs = now - position.buyTs;
    const underwaterPct = position.buyCostUsd > 0 ? (profitEst / position.buyCostUsd) * 100 : 0;
    const sl = walletStopLoss(i);
    if (underwaterPct <= -HARD_STOP_PCT) {
      log(`HARD STOP: ${underwaterPct.toFixed(1)}% <= -${HARD_STOP_PCT}% (no time gate) — selling`);
      await executeSell(ctx, i, position, 'stop-loss', log).catch((e) => log(`sell error: ${e.message}`));
      await kvPut(env, `wallet:${i}:rng`, rngState);
      return;
    }
    if (underwaterPct <= -sl.pct && heldMs >= sl.holdMs) {
      log(`STOP-LOSS: ${underwaterPct.toFixed(1)}% <= -${sl.pct.toFixed(1)}% (w${i} threshold) after ${(heldMs / 3600000).toFixed(1)}h >= ${(sl.holdMs / 3600000).toFixed(1)}h — selling at loss (discipline)`);
      await executeSell(ctx, i, position, 'stop-loss', log).catch((e) => log(`sell error: ${e.message}`));
      await kvPut(env, `wallet:${i}:rng`, rngState);
      return;
    }

    // 4b) MAX-HOLD exit (2026-10-08 deadlock breaker): orphan positions older than
    // 8h from entry exit at market. The 1.5x gate is INTENTIONALLY bypassed here —
    // orphan cost basis is a reconstruction fiction, so the gate would freeze the
    // wallet forever; stop-loss is the precedent for knowing exits at a loss.
    // Safety: (a) the data-quality blind gate at the top of processWallet already
    // applied — no bypass; (b) the fresh sell quote above failed => the branch
    // already returned, so sellValueUsd/sellGasUsd are valid; (c) only the wallet
    // pre-picked by runTick's deterministic precompute (maxhold:exitWallet) can
    // fire — one exit per tick even across the 4-way batch; (d) executeSell
    // re-reads balanceOf fresh and recordClose verifies before clearing —
    // UNKNOWN-on-timeout: executeSell throws, the catch logs, the position is
    // NOT cleared. Never clear a position without a confirmed sell.
    const maxholdIdx = await kvGet(env, 'maxhold:exitWallet', -1);
    if (maxholdIdx === i && position.comboKey && String(position.comboKey).startsWith('orphan')
        && (now - position.buyTs) >= ORPHAN_MAX_HOLD_MS) {
      log(`MAX-HOLD: orphan position held ${Math.round((now - position.buyTs) / 3600000)}h >= 8h — exiting at market (1.5x gate bypassed, precedent: stop-loss)`);
      await executeSell(ctx, i, position, 'max-hold', log, 1.0).catch((e) => log(`max-hold sell error: ${e.message}`));
      await kvPut(env, `wallet:${i}:rng`, rngState);
      return;
    }

    log(`HOLD (profitEst $${profitEst.toFixed(4)}, underwater ${underwaterPct.toFixed(1)}%, held ${Math.round(heldMs / 60000)}m)`);
    await kvPut(env, `wallet:${i}:rng`, rngState);
    return;
  }

  // ---------------- FLAT: three buy signals (Anthony 2026-10-07 14:26) ----------------
  // The bot must recognize "price is low", not just "price crashed suddenly".
  // 1. CRASH BUY: sudden dump >= learned dump threshold (DUMP_GRID) in 1-2 ticks.
  // 2. VALUE BUY: price >= learned value threshold (VALUE_GRID) below the 1h high AND
  //    stable this tick (drop < STABLE_MAX_DROP_PCT) — cheap and settling, not mid-crash.
  // 3. BOTTOM BUY: price within NEAR_LOW_PCT of the 24h low.
  // ANY one fires. The bandit learns which thresholds actually make money.
  const dBps = dipBps(highSq, nowSq);
  const dPct = dBps / 100;
  const tickDropPct = moveBps < 0 ? -moveBps / 100 : 0; // this tick's drop
  const tickPrev = await kvGet(env, 'price:tickPrev', null);
  const twoTickDropPct = tickPrev && BigInt(tickPrev.sq) > nowSq
    ? Number((BigInt(tickPrev.sq) - nowSq) * 10000n / BigInt(tickPrev.sq)) / 100 : 0;
  // How far above the 24h low are we? (0% = at the low).
  const aboveLowBps = nowSq > low24Sq ? Number((nowSq - low24Sq) * 10000n / low24Sq) : 0;
  const aboveLowPct = aboveLowBps / 100;
  const nearLow = aboveLowPct <= NEAR_LOW_PCT;

  // (combo already selected pre-gate above: ck / activeDump / activeValue / activeMargin / activeSize / activeCd)
  const dumpThr = activeDump, valueThr = activeValue; // (aliases for the signal math below)
  log(`buy check: tick ${tickDropPct.toFixed(1)}% / 2-tick ${twoTickDropPct.toFixed(1)}% | 1h-high dip ${dPct.toFixed(2)}% | ${aboveLowPct.toFixed(1)}% above 24h low${nearLow ? ' (NEAR LOW)' : ''} (combo ${ck})`);

  const crashBuy = tickDropPct >= dumpThr || twoTickDropPct >= dumpThr;
  // PLUS ULTRA EYES #2: TWAP confirmation — a "value" buy must actually sit at or
  // below the 10-min TWAP (2% tolerance). Buying above TWAP isn't value, it's chasing.
  const belowTwap = ctx.twapSq ? nowSq <= ctx.twapSq * 102n / 100n : true;
  const valueBuy = dPct >= valueThr && tickDropPct < STABLE_MAX_DROP_PCT && belowTwap;
  // (review) see bottomSignal(): the low must have held 30 min and price must have
  // bounced >= 2% off it. Buying AT a fresh low was the 9%-win-rate falling knife.
  const bottomBuy = bottomSignal(aboveLowPct, now - (ctx.low24Ts || now));
  if (!crashBuy && !valueBuy && !bottomBuy) {
    log(`no buy signal (need: dump>=${dumpThr}% | >=${valueThr}% below 1h high & stable | ${BOTTOM_MIN_BOUNCE_PCT}-${NEAR_LOW_PCT}% above a 24h low that held ${BOTTOM_MIN_LOW_AGE_MS / 60e3}m) — skip`);
    return;
  }
  const sig = crashBuy ? `CRASH ${Math.max(tickDropPct, twoTickDropPct).toFixed(1)}% dump`
    : valueBuy ? `VALUE ${dPct.toFixed(1)}% below 1h high, stable`
    : `BOTTOM within ${aboveLowPct.toFixed(1)}% of 24h low`;

  // NN buy gate (v1 advisory): score the setup. Veto if buyScore < gate.
  // If it passes, the NN's continuous buySize overrides the bandit's discrete grid.
  let nnSizePct = activeSize;
  try {
    const nnw = await nnLoad(env, i, rngState);
    const ethBalNow = await publicClient.getBalance({ address: addr }).catch(() => 0n);
    const statsNow = (await kvGet(env, `wallet:${i}:stats`, null)) || { points: 0 };
    const feats = buildFeatures({
      buckets: ctx.buckets || [], nowSq, highSq, low24Sq, prevSq,
      moveBps, prevMoveBps: ctx.prevMoveBps, pattern: ctx.pattern,
      ethBal: ethBalNow, brawlBal: 0n, position: null, stats: statsNow,
      gasPriceWei: ctx.gasPriceWei || 0n, ethUsd,
      ethUsdPrev1h: ctx.ethUsdPrev1h, now,
      unrealizedPnlPct: 0,
      fleet: ctx.fleet, walletIdx: i,
      // PLUS ULTRA senses (shared per-tick via ctx); flat wallet → no market impact
      volumeStats: ctx.volumeStats, depth2pctWeth: ctx.depth2pctWeth, positionWeth: 0,
      gasSpike: ctx.gasSpike, whaleNetBrawl: ctx.whaleNetBrawl, priceVelAnn: ctx.priceVelAnn,
      lastSell, // swing-cycle: F[38] time-since-sell
      dataQuality: ctx.dataQuality, // F[45] NEVER BE BLIND
    });
    const fwd = nnForward(nnw, feats);
    const buyScore = fwd.out[0];
    const nnLive = (nnw.nTrained || 0) >= NN_MIN_TRAINED;
    // Continuous size: 10% + 90% * buySize output → [10%, 100%]. Only once trusted;
    // an untrained net would size from random weights (could go 100% all-in).
    const nnRawSize = Math.round(10 + 90 * fwd.out[1]);
    nnSizePct = nnLive ? nnRawSize : activeSize;
    log(`NN: buyScore=${buyScore.toFixed(3)} (gate ${NN_BUY_GATE}) size=${nnRawSize}% (bandit ${activeSize}%)${nnLive ? '' : ` — advisory only, ${nnw.nTrained || 0}/${NN_MIN_TRAINED} trained closes`}`);
    if (nnLive && buyScore < NN_BUY_GATE) {
      log(`NN VETO: buyScore ${buyScore.toFixed(3)} < ${NN_BUY_GATE} — skipping bandit buy signal (${sig})`);
      return;
    }
    // Snapshot features for online training when this trade closes.
    await kvPut(env, nnPendingKey(i), {
      features: feats, buySizePct: nnSizePct, buyTs: now,
      comboKey: ck,
    });
  } catch (e) {
    log(`NN buy-gate failed (${e.message}) — proceeding with bandit signal`);
  }
  log(`BUY SIGNAL — ${sig} — sizing ${nnSizePct}% (NN)`);
  try {
    await executeBuy(ctx, i, { key: ck, dump: dumpThr, value: valueThr, margin: activeMargin, size: nnSizePct, cd: activeCd }, dPct, log);
  } catch (e) {
    log(`buy error: ${e.message}`);
  }
}

// ------------------------------------------------------- pattern learning ---
// Track the coin's pump/dump cycles so the bot learns THIS coin's rhythm.
// A "swing" is a >5% move from the last recorded extreme; we log its size,
// direction, and duration, then maintain rolling averages in KV.
const SWING_PCT = 5;
async function updatePatterns(env, prevSq, nowSq, now, log) {
  let pat = (await kvGet(env, 'pattern', null)) || {
    pumps: [], dumps: [],
    avgPumpPct: 0, avgDumpPct: 0, avgCycleMs: 0,
    lastExtremeSq: nowSq.toString(), lastExtremeTs: now, lastExtremeDir: null,
    swingTs: [], // timestamps of >5% swings (for swings1h feature)
  };
  if (!pat.swingTs) pat.swingTs = [];
  const lastSq = BigInt(pat.lastExtremeSq);
  if (lastSq === 0n) { pat.lastExtremeSq = nowSq.toString(); pat.lastExtremeTs = now; }
  else {
    const moveBps = nowSq >= lastSq
      ? Number((nowSq - lastSq) * 10000n / lastSq)
      : -Number((lastSq - nowSq) * 10000n / lastSq);
    const movePct = moveBps / 100;
    if (Math.abs(movePct) >= SWING_PCT) {
      const dir = movePct > 0 ? 'pump' : 'dump';
      const durMs = now - pat.lastExtremeTs;
      if (dir === 'pump') {
        pat.pumps.push(movePct); if (pat.pumps.length > 20) pat.pumps.shift();
        pat.avgPumpPct = pat.pumps.reduce((a, b) => a + b, 0) / pat.pumps.length;
      } else {
        pat.dumps.push(Math.abs(movePct)); if (pat.dumps.length > 20) pat.dumps.shift();
        pat.avgDumpPct = pat.dumps.reduce((a, b) => a + b, 0) / pat.dumps.length;
      }
      // Cycle = time between consecutive extremes (pump->dump or dump->pump).
      if (pat.lastExtremeDir && pat.lastExtremeDir !== dir) {
        pat.avgCycleMs = pat.avgCycleMs === 0 ? durMs : pat.avgCycleMs * 0.8 + durMs * 0.2;
        log(`PATTERN: ${dir} ${Math.abs(movePct).toFixed(1)}% in ${Math.round(durMs / 60000)}m | avg pump ${pat.avgPumpPct.toFixed(1)}% / dump ${pat.avgDumpPct.toFixed(1)}% / cycle ${Math.round(pat.avgCycleMs / 60000)}m`);
      }
      pat.lastExtremeSq = nowSq.toString();
      pat.lastExtremeTs = now;
      pat.lastExtremeDir = dir;
      pat.swingTs.push(now);
      await kvPut(env, 'pattern', pat);
    }
  }
  // Prune swings older than 1h; expose count for the NN.
  pat.swingTs = pat.swingTs.filter(t => now - t <= 3600e3);
  pat.swings1h = pat.swingTs.length;
  return pat;
}

// ------------------------------------------------------------------ leaderboard ---
async function maybeLogLeaderboard(env, log) {
  const last = (await kvGet(env, 'meta:lastBoardLog', 0));
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < BURNERS.length; i++) {
    const s = (await kvGet(env, `wallet:${i}:stats`)) || { points: 0, trades: 0, pnlUsd: 0 };
    rows.push({ i, points: s.points || 0, pnlUsd: s.pnlUsd || 0, trades: s.trades || 0,
      avgRoi: s.avgRoi || 0, profitPerHourUsd: s.profitPerHourUsd || 0 });
  }
  rows.sort((a, b) => b.points - a.points);
  await kvPut(env, 'leaderboard', rows);
  if (now - last >= BOARD_LOG_MS) {
    log('=== LEADERBOARD (24h) ===');
    rows.forEach((r, rank) =>
      log(`#${rank + 1} w${r.i}: ${r.points}pts | pnl $${r.pnlUsd.toFixed(4)} | ${r.trades} trades | avgROI ${(r.avgRoi * 100).toFixed(1)}% | $/h $${r.profitPerHourUsd.toFixed(2)}`));
    await kvPut(env, 'meta:lastBoardLog', now);
  }
  return rows;
}

// ------------------------------------------------------------------ tick ---
async function runTick(env, log) {
  const now = Date.now();
  const dryRun = env.DRY_RUN === 'true';
  const RPC_URLS = (env.RPC_URLS || env.RPC_URL || 'https://mainnet.base.org').split(',').map(s => s.trim()).filter(Boolean);
  if (env.BURNER_ADDRESSES) BURNERS = env.BURNER_ADDRESSES.split(',').map((a) => a.trim());
  // Threshold-grid override (fork tournament / experiments ONLY). Changing the grid on
  // live state wipes every Q-table via the QGRID_VER check below — never set these on
  // the live fleet without meaning to. e.g. DUMP_GRID="5,10,15,20" VALUE_GRID="10,20,30"
  if (env.DUMP_GRID) DUMP_GRID = env.DUMP_GRID.split(',').map(Number);
  if (env.VALUE_GRID) VALUE_GRID = env.VALUE_GRID.split(',').map(Number);
  if (dryRun) log('*** DRY_RUN mode — no broadcasts ***');

  // Try each RPC in order; use the first that serves the price read.
  let publicClient = null, nowSq = null, rpcUsed = null;
  let lastErr = null;
  // RPC SELECTION TIMEOUT (2026-10-08): during egress wedges, even viem's 15s
  // timeout can hang at TCP/CONNECT. Cap the entire selection loop at 60s —
  // 3 RPCs x 15s + overhead. If we can't get a price in 60s, SAFE-ABORT.
  const RPC_SELECT_TIMEOUT_MS = 60000;
  const rpcSelectStart = Date.now();
  for (const rpcUrl of RPC_URLS) {
    if (Date.now() - rpcSelectStart > RPC_SELECT_TIMEOUT_MS) {
      lastErr = new Error(`RPC selection timeout after ${RPC_SELECT_TIMEOUT_MS}ms`);
      break;
    }
    try {
      const pc = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 15000 }) });
      const sq = await raceTimeout(fetchPoolSq(pc), 20000, `fetchPoolSq timeout on ${rpcUrl}`);
      publicClient = pc; nowSq = sq; rpcUsed = rpcUrl;
      break;
    } catch (e) { lastErr = e; }
  }
  if (!publicClient) {
    // SAFE-ABORT (not FATAL): without a price we cannot trade. The babies stay
    // blind rather than trade blind. This is the system working as designed.
    // (Anthony 2026-10-08: "they can never be blind. they can never fail.")
    log(`SAFE-ABORT: pool price read failed on all RPCs (${RPC_URLS.length} tried, last: ${lastErr && lastErr.message}) — tick skipped, no trades`);
    return;
  }
  log(`rpc: ${rpcUsed}`);
  const priceWeth = sqToWethPerBrawl(nowSq);

  // PLUS ULTRA #10 (2026-10-07 23:07): circuit breaker — a >20%/min move trips a
  // 5-min all-trading halt. Ruthless, not reckless: in a flash move quotes are stale
  // and the 1.5x-gate math is fiction. Price history still updates during the halt.
  const trip = await kvGet(env, 'circuit:tripped', null);
  if (trip && now >= trip.until) {
    await kvPut(env, 'circuit:tripped', null); // expired — resume trading
    log('circuit breaker expired — resuming');
  } else if (trip) {
    log(`CIRCUIT BREAKER: tripped ${(trip.movePct)}% at ${new Date(trip.ts).toISOString()} — cooling until ${new Date(trip.until).toISOString()}, trading paused`);
    let qb = await kvGet(env, 'price:buckets', []);
    qb.push({ ts: now, sq: nowSq.toString() });
    if (qb.length > 300) qb = qb.slice(-300);
    await kvPut(env, 'price:buckets', qb);
    await kvPut(env, 'price:tick', { sq: nowSq.toString(), ts: now, prevMoveBps: 0 });
    log('tick complete (circuit-breaker)');
    return;
  }

  // 2b) Quiet-tick listener (Anthony 2026-10-07 13:41 EDT): on dead ticks (<0.50% move
  // since last tick) just update price history and exit — no ETH/USD fetch, no trading,
  // no gas wasted. The 1-min cron becomes an efficient listener.
  const prev = await kvGet(env, 'price:tick', null);
  const prevSq = prev ? BigInt(prev.sq) : nowSq;
  const moveBps = prev ? riseBps(prevSq, nowSq) : 0; // signed bps, + = price up
  // PLUS ULTRA #10: trip the breaker on a >20% one-minute move. The 10-20% band
  // still gets the spike-sell treatment (3b); beyond 20% we halt everything —
  // no FOMO buys into a vertical pump, no panic dumps into a flash crash.
  if (prev && Math.abs(moveBps) / 100 > CIRCUIT_MOVE_PCT) {
    await kvPut(env, 'circuit:tripped', {
      ts: now, until: now + CIRCUIT_HALT_MS, movePct: Number((moveBps / 100).toFixed(1)),
    });
    log(`CIRCUIT BREAKER TRIPPED: ${(moveBps / 100).toFixed(1)}% in ~1 min — halting all trading for 5 min`);
    let tqb = await kvGet(env, 'price:buckets', []);
    tqb.push({ ts: now, sq: nowSq.toString() });
    if (tqb.length > 300) tqb = tqb.slice(-300);
    await kvPut(env, 'price:buckets', tqb);
    await kvPut(env, 'price:tick', { sq: nowSq.toString(), ts: now, prevMoveBps: moveBps });
    if (prev) await kvPut(env, 'price:tickPrev', { sq: prev.sq, ts: prev.ts });
    log('tick complete (circuit-breaker tripped)');
    return;
  }
  if (prev && Math.abs(moveBps) < QUIET_MOVE_BPS) {
    let qHigh = await kvGet(env, 'price:high1h', null);
    if (!qHigh || now - qHigh.ts > HIGH_WINDOW_MS || nowSq > BigInt(qHigh.sq)) {
      qHigh = { sq: nowSq.toString(), ts: now };
    }
    const qLow = rollLow24(await kvGet(env, 'price:low24h', null), nowSq, now,
      (await kvGet(env, 'price:buckets', [])) || []);
    // WAKE-UP (Anthony 2026-10-07 14:26): a quiet tick is only quiet if price is NOT
    // sitting at value levels. If we're deep below the 1h high or near the 24h low, a
    // wallet's VALUE/BOTTOM buy signal may fire — fall through to full logic instead
    // of sleeping through a cheap market. Thresholds here are the most permissive
    // grid values so no wallet's learned gate gets blocked by the quiet exit.
    const qDipPct = dipBps(BigInt(qHigh.sq), nowSq) / 100;
    const qAboveLowPct = nowSq > BigInt(qLow.sq)
      ? Number((nowSq - BigInt(qLow.sq)) * 10000n / BigInt(qLow.sq)) / 100 : 0;
    const maybeValue = qDipPct >= Math.min(...VALUE_GRID) || bottomSignal(qAboveLowPct, now - qLow.ts);
    // HOLDING wake-up (2026-10-07 14:49): wallets with open positions must evaluate
    // exits every tick — a stable price can still be above a wallet's target. Without
    // this, a holding wallet sleeps through profitable exits on quiet ticks.
    let anyHolding = false;
    for (let wi = 0; wi < BURNERS.length && !anyHolding; wi++) {
      const hp = await kvGet(env, `wallet:${wi}:position`, null);
      if (hp) anyHolding = true;
    }
    if (!maybeValue && !anyHolding) {
      log(`quiet tick: ${(moveBps / 100).toFixed(2)}% move < 0.50% — price history updated, trading skipped`);
      await kvPut(env, 'price:tick', { sq: nowSq.toString(), ts: now, prevMoveBps: moveBps });
      if (prev) await kvPut(env, 'price:tickPrev', { sq: prev.sq, ts: prev.ts }); // 2-tick dump window
      await kvPut(env, 'price:high1h', qHigh);
      await kvPut(env, 'price:low24h', qLow);
      // Still record the bucket so NN features stay fresh on quiet ticks.
      let qb = await kvGet(env, 'price:buckets', []);
      qb.push({ ts: now, sq: nowSq.toString() });
      if (qb.length > 300) qb = qb.slice(-300);
      await kvPut(env, 'price:buckets', qb);
      log('tick complete (quiet)');
      return;
    }
    log(`wake-up: quiet tick but ${anyHolding ? 'a wallet is holding' : ''}${anyHolding && maybeValue ? ' and ' : ''}${maybeValue ? `price at value levels (${qDipPct.toFixed(1)}% below 1h high, ${qAboveLowPct.toFixed(1)}% above 24h low)` : ''} — running full logic`);
  }
  if (prev) log(`tick move: ${(moveBps / 100).toFixed(2)}% since last tick`);

  // 2) ETH/USD (needed for all USD math).
  const ethUsd = await fetchEthUsd(env, log, publicClient);
  if (!ethUsd) { log('no ETH/USD — aborting tick (safe)'); return; }
  const priceUsd = priceWeth * ethUsd;
  log(`price: ${priceWeth.toExponential(4)} WETH/BRAWL ($${priceUsd.toExponential(4)}) | ETH $${ethUsd}`);

  // 3) Price history: prev tick (spike) + 1h high (dip) + 24h low (selective entries).
  // (prev/prevSq/moveBps computed above for the quiet-tick check.)
  let high = await kvGet(env, 'price:high1h', null);
  if (!high || now - high.ts > HIGH_WINDOW_MS || nowSq > BigInt(high.sq)) {
    high = { sq: nowSq.toString(), ts: now };
  }
  // Rolling price buckets for NN multi-timeframe features (last 300 ticks ≈ 5h).
  let buckets = await kvGet(env, 'price:buckets', []);
  buckets.push({ ts: now, sq: nowSq.toString() });
  if (buckets.length > 300) buckets = buckets.slice(-300);
  await kvPut(env, 'price:buckets', buckets);
  const bucketsBig = buckets.map(b => ({ ts: b.ts, sq: BigInt(b.sq) }));
  const low24 = rollLow24(await kvGet(env, 'price:low24h', null), nowSq, now, buckets);
  // Previous tick's move (for acceleration feature). Stored on price:tick.
  const prevMoveBps = prev && prev.prevMoveBps != null ? prev.prevMoveBps : 0;
  await kvPut(env, 'price:tick', { sq: nowSq.toString(), ts: now, prevMoveBps: moveBps });
  if (prev) await kvPut(env, 'price:tickPrev', { sq: prev.sq, ts: prev.ts }); // 2-tick dump window
  await kvPut(env, 'price:high1h', high);
  await kvPut(env, 'price:low24h', low24);
  const highSq = BigInt(high.sq);
  const low24Sq = BigInt(low24.sq);

  // 3c) Pattern learning: track significant moves (>5%) to learn pump/dump cycles.
  // Stores in KV: {pumps: [...], dumps: [...], avgPumpPct, avgDumpPct, avgCycleMs, lastExtreme}
  const pattern = await updatePatterns(env, prevSq, nowSq, now, log);

  // NN shared per-tick data: gas price (one read, reused by all wallets).
  let gasPriceWei = 0n;
  try { gasPriceWei = await publicClient.getGasPrice(); } catch (e) { /* leave 0 */ }
  // PLUS ULTRA #5b: gas spike — tanh((gwei - lastTickGwei)/5). The 1.5x profit gate
  // is gas-sensitive; spiking gas means re-time the exit. Stored per tick in KV.
  let gasSpike = 0;
  try {
    const gweiNow = Number(gasPriceWei) / 1e9;
    const gasLast = await kvGet(env, 'gas:last', null);
    if (gasLast && gasLast.gwei > 0 && gweiNow > 0) {
      gasSpike = Math.tanh((gweiNow - gasLast.gwei) / 5);
      if (Math.abs(gasSpike) > 0.3) log(`gas spike: ${gasLast.gwei.toFixed(2)} → ${gweiNow.toFixed(2)} gwei (F[35]=${gasSpike.toFixed(2)})`);
    }
    if (gweiNow > 0) await kvPut(env, 'gas:last', { gwei: gweiNow, ts: now });
  } catch (e) { /* gas spike is advisory */ }
  // PLUS ULTRA senses (2026-10-07 23:07): computed once per tick, shared via ctx.
  // EYES #1 (slot0 direct) is already the price path — fastest possible, no HTTP.
  const twapSq = computeTwapSq(bucketsBig, now);                 // EYES #2
  if (twapSq) {
    const twapDivBps = nowSq >= twapSq
      ? Number((nowSq - twapSq) * 10000n / twapSq) : -Number((twapSq - nowSq) * 10000n / twapSq);
    log(`twap(10m): spot ${twapDivBps >= 0 ? '+' : ''}${(twapDivBps / 100).toFixed(2)}% vs TWAP`);
  }
  const swapFlow = await fetchSwapFlow(publicClient, log);       // EYES #3 + EARS #6
  const depth2pctWeth = await fetchDepth2pctWeth(publicClient, priceWeth, log); // EYES #4
  const priceVelAnn = computePriceVelAnn(bucketsBig, now);       // EARS #8
  if (priceVelAnn > 0) log(`price velocity: ${(priceVelAnn * 100).toFixed(0)}% annualized`);
  // EARS #7 (mempool snipe detector): deferred — no mempool API is wired in this
  // environment, and polling one would add an HTTP dependency to the hot path.
  // Revisit when a reliable mempool feed exists; the feature slot is reserved.
  const ethUsdPrev = await kvGet(env, 'ethusd:prev1h', null);
  // DATA QUALITY (Anthony 2026-10-08 00:17 EDT): babies can NEVER be blind.
  // Track which critical reads succeeded. F[45] exposes this live.
  // 1.0 = all fresh, 0.0 = flying blind. Low quality → DO NOT TRADE.
  let dataQualityReads = 0, dataQualityTotal = 5;
  if (priceWeth && priceWeth > 0) dataQualityReads++;
  if (swapFlow) dataQualityReads++;
  if (depth2pctWeth && depth2pctWeth > 0) dataQualityReads++;
  if (ethUsd && ethUsd > 0) dataQualityReads++;
  if (gasPriceWei && gasPriceWei > 0n) dataQualityReads++;
  const dataQuality = dataQualityReads / dataQualityTotal;
  if (dataQuality < 1.0) log(`DATA QUALITY: ${dataQualityReads}/${dataQualityTotal} reads ok (${(dataQuality*100).toFixed(0)}%)`);
  const ctx = { env, publicClient, ethUsd, nowSq, prevSq, moveBps, prevMoveBps,
    highSq, low24Sq, low24Ts: low24.ts, priceWeth, priceUsd, now, dryRun, log,
    buckets: bucketsBig, pattern, gasPriceWei,
    ethUsdPrev1h: ethUsdPrev && now - ethUsdPrev.ts < 2 * 3600e3 ? ethUsdPrev.price : null,
    // PLUS ULTRA senses shared to all wallets:
    volumeStats: swapFlow ? { buyVol: swapFlow.buyVol, sellVol: swapFlow.sellVol } : null,
    whaleNetBrawl: swapFlow ? swapFlow.whaleNetBrawl : null,
    depth2pctWeth, gasSpike, priceVelAnn, twapSq, dataQuality };
  // Arena opponent-awareness (2026-10-07 22:00 EDT): fleet posture computed once
  // per tick, shared to all wallets via ctx.fleet. Each baby sees the competition.
  try {
    ctx.fleet = await computeFleetStats(env, log);
  } catch (e) {
    log(`fleet stats failed (${e.message}) — NN opponent features will use neutral fallbacks`);
    ctx.fleet = null;
  }
  // Snapshot ETH/USD hourly for the NN's eth_usd_ret_1h feature.
  const lastSnap = await kvGet(env, 'ethusd:snapTs', 0);
  if (now - lastSnap > 3600e3) {
    await kvPut(env, 'ethusd:prev1h', { price: ethUsd, ts: now });
    await kvPut(env, 'ethusd:snapTs', now);
  }

  // 3b) Spike listener (Anthony 2026-10-07 13:41 EDT): +10% in ONE tick (likely Anthony
  // or a big buyer) -> immediate exit pass. Every holding wallet attempts its spike sell
  // in THIS invocation, before normal per-wallet logic. Cooldowns don't block profit.
  // WREN: this pass tries to sell EVERY holding wallet in the same tick (each one only
  // needs the 1.5x-gas bar, not its own margin target) — the same synchronized
  // multi-wallet exit you banned for stop-losses. And if the spike really is Anthony
  // buying, the fleet is selling straight into its own owner: same beneficial owner on
  // both sides. Prefer: only wallets whose OWN target is met, staggered across ticks.
  if (prev && moveBps >= SPIKE_PCT * 100) {
    log(`!!! SPIKE +${(moveBps / 100).toFixed(1)}% since last tick — immediate exit pass on all wallets`);
    for (let i = 0; i < BURNERS.length; i++) {
      try {
        const position = await kvGet(env, `wallet:${i}:position`, null);
        if (!position) continue;
        const r = await executeSell({ ...ctx, log }, i, position, 'spike', log)
          .catch((e) => { log(`[w${i}] spike sell error: ${e.message}`); return null; });
        if (r) log(`[w${i}] spike exit executed`);
      } catch (e) { log(`[w${i}] spike pass error: ${e.message}`); }
    }
  }

  // MAX-HOLD precompute (2026-10-08 deadlock breaker): deterministically pick at most
  // ONE orphan max-hold exit for this tick, in wallet index order (first eligible
  // wins). The 4-way batch loop below runs processWallet concurrently, so the pick
  // must be made up-front and shared read-only via KV — two wallets can never both
  // match 'maxhold:exitWallet' in the same tick. Race-safe by construction: the loop
  // is a single sequential pass, the KV writes are awaited before any batch starts.
  // The actual exit still runs inside processWallet, so the data-quality blind gate
  // and the quote-failure HOLD both still apply — this precompute exits no one.
  let maxholdExit = -1;
  try {
    for (let i = 0; i < BURNERS.length; i++) {
      const p = await kvGet(env, `wallet:${i}:position`, null);
      if (p && p.comboKey && String(p.comboKey).startsWith('orphan') && (now - p.buyTs) >= ORPHAN_MAX_HOLD_MS) {
        maxholdExit = i;
        break;
      }
    }
    await kvPut(env, 'maxhold:exitWallet', maxholdExit);
    await kvPut(env, 'maxhold:exitTick', now);
    log(maxholdExit >= 0
      ? `MAX-HOLD: wallet ${maxholdExit} pre-picked for market exit this tick (orphan >= 8h)`
      : 'MAX-HOLD: none eligible');
  } catch (e) {
    log(`MAX-HOLD precompute failed (${e.message}) — no max-hold exits this tick`);
  }

  // 4) Wallets in parallel (4-way batches) — independent decisions, one failure never kills the tick.
  // (Anthony 2026-10-08 01:22 EDT "fix that": serial 16 wallets x ~15s each = 240s+ blew the 300s budget.
  // Each wallet uses its own KV keys; ctx market data is read-only. 4-way keeps RPC load sane.)
  //
  // HARD TIMEOUTS (Anthony 2026-10-08 01:42 EDT "make sure it doesnt go down during those issues"):
  // During egress wedges, RPC calls hang at TCP/CONNECT level beyond viem's 15s timeout.
  // Without hard timeouts, one hung wallet blocks its entire batch indefinitely.
  // Each wallet gets 45s max; each batch gets 120s max. Timeouts are logged, never fatal.
  const WALLET_CONCURRENCY = 4;
  const WALLET_TIMEOUT_MS = 45000;
  const BATCH_TIMEOUT_MS = 120000;
  const withTimeout = (promise, ms, label) => raceTimeout(promise, ms, `${label} timeout after ${ms}ms`);
  for (let batch = 0; batch < BURNERS.length; batch += WALLET_CONCURRENCY) {
    const ids = [];
    for (let k = 0; k < WALLET_CONCURRENCY && batch + k < BURNERS.length; k++) ids.push(batch + k);
    try {
      await withTimeout(
        Promise.all(ids.map(i => {
          // (2026-10-08: cooperative wallet deadline) Promise.race alone does NOT
          // cancel the loser — a timed-out processWallet kept running and could
          // broadcast AFTER the tick moved on (double-sell / phantom position
          // risk). Each wallet gets an AbortController: the timeout aborts it,
          // and sendRawTx refuses any post-deadline broadcast. In-flight
          // settlement (waitReceipt → recordClose) is NOT aborted — a broadcast
          // tx must always be accounted for, never orphaned.
          const ac = new AbortController();
          const wctx = Object.assign({}, ctx, { signal: ac.signal });
          const work = processWallet(wctx, i, log).catch(e => log(`[w${i}] TICK ERROR: ${e.message}`));
          let timer;
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
              ac.abort();
              reject(new Error(`w${i} timeout after ${WALLET_TIMEOUT_MS}ms (aborted; settlement may still complete)`));
            }, WALLET_TIMEOUT_MS);
          });
          return Promise.race([work, deadline])
            .catch(e => log(`[w${i}] WALLET TIMEOUT: ${e.message}`))
            .finally(() => clearTimeout(timer));
        })),
        BATCH_TIMEOUT_MS,
        `batch ${batch / WALLET_CONCURRENCY}`
      );
    } catch (e) {
      log(`BATCH TIMEOUT: ${e.message} — continuing to next batch`);
    }
  }

  // 4b) Superintelligence post-pass (2026-10-07 23:05 EDT):
  //   - scorePendingSells: deferred ruthlessness bonuses (#1/#2/#3)
  //   - maybeRunTournament: daily zero-sum ranking (#6)
  //   - applyCashDrag: swing-cycle — flat wallets bleed during rallies (2026-10-07 23:37)
  try { await scorePendingSells(env, nowSq, log); } catch (e) { log(`ruthlessness scoring failed: ${e.message}`); }
  try { await maybeRunTournament(env, log); } catch (e) { log(`tournament failed: ${e.message}`); }
  try { await applyCashDrag(env, bucketsBig, nowSq, now, log); } catch (e) { log(`cash drag failed: ${e.message}`); }

  // 5) Leaderboard.
  await maybeLogLeaderboard(env, log);
  log('tick complete');
}

// Tick lock: prevents double-trades when two schedulers (Cloudflare cron +
// external ticker) fire concurrently. Best-effort via KV; 45s window.
async function acquireTickLock(env, log) {
  const now = Date.now();
  const last = (await kvGet(env, 'meta:tickLock', 0)) || 0;
  if (now - last < 45000) {
    log(`tick skipped: previous tick started ${Math.round((now - last) / 1000)}s ago (lock)`);
    return false;
  }
  try { await kvPut(env, 'meta:tickLock', now); } catch (e) { /* lock write failed: proceed, log covers it */ }
  return true;
}

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
export const __internal = { getQuote, resolveSellPermits, sendRawTx, waitReceipt, ensureSellApproval, ERC20_ABI };
export const __test = {
  closeReward, rollLow24, bottomSignal, buildFeatures, blankQTable, parseCombo, comboKey,
  selectCombo, computePriceVelAnn, NN_IN, LOW_WINDOW_MS,
};
