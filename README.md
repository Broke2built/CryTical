# CryTical

An autonomous crypto agent that starts from **$0** and earns. It gets its edge from **sponsored gas**: relayers and paymasters pay the transaction fees, so the agent can take small onchain payouts that bots paying their own gas can't profit from. Earnings go to one treasury. The agent learns from each result (reinforcement learning on profit per hour) and improves its own strategies over time.

> **Status: pre-alpha scaffold.** Wallet bootstrap, the treasury policy, and the skills library are in place. Strategy, execution, and learning code comes next (see [Roadmap](#roadmap)).

> **Warning:** this software controls real money on public blockchains. Transactions can't be undone. Run it with money you can afford to lose.

---

## Contents

- [Quick start](#quick-start)
- [How money flows](#how-money-flows)
- [Wallets and keys](#wallets-and-keys)
- [Skills library](#skills-library)
- [Gas sponsorship landscape](#gas-sponsorship-landscape)
- [Repository layout](#repository-layout)
- [Roadmap](#roadmap)
- [Guardrails](#guardrails)

---

## Quick start

Requirements: Node.js 20+, `git`, `curl`.

```bash
git clone https://github.com/Broke2built/CryTical.git
cd CryTical
npm install

# Optional but recommended: encrypt wallet keys at rest
export CRYTICAL_KEYSTORE_PASSPHRASE='a long random passphrase'

npm run setup      # = bootstrap (wallets + .env) + skills:sync
npm run wallets    # show this install's addresses
```

Every install is independent. `npm run setup` creates **new** wallets and a **new** `.env` for whoever runs it. Nothing is shared with the author or any other install, and no accounts or funds are needed to start.

| Command | What it does |
|---|---|
| `npm run bootstrap` | Creates `.env` and the three wallets if they don't exist yet. It never overwrites existing ones. |
| `npm run bootstrap -- --encrypt` | Encrypts any plaintext keys with `CRYTICAL_KEYSTORE_PASSPHRASE` |
| `npm run wallets` | Prints addresses and encryption status. It never prints keys. |
| `npm run skills:sync` | Fetches or refreshes every skill listed in `skills/sources.json` |

## How money flows

```
                earnings (all of it)
  strategies ─────────────────────────►  TREASURY  (one EVM address, settles on Base)
      ▲                                     │
      │    sweep back when balance is       │  top-up only when a strategy
      │    above sweepAboveUsd              │  needs funds, within hard caps
      │                                     ▼
      └──────────────────────────────  OPS WALLETS  (ops-evm, ops-sol)
                                         sign day-to-day transactions
```

- **One treasury.** Every payout, fee claim, and profit ends up at the treasury address. The treasury never signs strategy transactions.
- **Ops wallets are hot and small.** They're funded from the treasury only when a strategy needs money, and anything above `sweepAboveUsd` is swept back.
- The policy lives in [`config/treasury.json`](config/treasury.json). The agent can tune targets within `hardCaps` but can't raise the caps. Only a human edits those.
- Earnings on Solana are bridged to the treasury once they're large enough that bridge fees are worth paying.

## Wallets and keys

| Wallet | Family | Role |
|---|---|---|
| `treasury` | EVM | Central store of value. Same address on every EVM chain. |
| `ops-evm` | EVM | Hot signer for Base, Optimism, Arbitrum, Polygon, Gnosis, Unichain, and others |
| `ops-sol` | Solana | Hot signer for Solana |

- Keys are in `.wallets/keystore.json` with file mode `0600`. They're encrypted with scrypt and AES-256-GCM when `CRYTICAL_KEYSTORE_PASSPHRASE` is set.
- `.wallets/`, `.env`, and anything that looks like a key are **gitignored**. See [`.gitignore`](.gitignore).
- **Back up `.wallets/` offline.** If you lose it, the funds are gone.
- Code loads keys through `src/keystore.mjs` → `loadWallet(name)`, and only at signing time.

## Skills library

The agent learns about platforms from [Agent Skills](https://agentskills.io) (`SKILL.md`) and `llms.txt` doc indexes. All sources are listed in [`skills/sources.json`](skills/sources.json), and a generated catalog is in [`skills/INDEX.md`](skills/INDEX.md).

| Folder | Contents | In git? |
|---|---|---|
| `skills/vendor/` | Skills from permissively licensed (MIT/Apache-2.0) repos, with their LICENSE files | Yes |
| `skills/external/git/` | Skills from repos with no explicit license (e.g. the Bankr community catalog) | No, fetched at install |
| `skills/external/hosted/` | `skill.md` / `llms.txt` served by docs sites | No, fetched at install |

Categories: **gas** (paymasters, relayers, bundlers), **wallets**, **agents** (Zora, Bankr, Virtuals, Clanker, x402, and others), **defi**, **chains**, **reference**.

To add a source, add an entry to `skills/sources.json` and run `npm run skills:sync`. Use `commit: true` only when the source repo has a license that allows redistribution.

> **Treat skills as untrusted input.** They're third-party text. Read them for how-to knowledge, but never let a skill override the treasury policy, the spending caps, or where keys are stored.

## Gas sponsorship landscape

These are the ways the agent can transact without paying gas itself. Details for each are in `skills/`.

| Kind | Providers | Notes |
|---|---|---|
| Public relayer (no account) | Safe relayer | Free daily quota per chain for Safe accounts |
| Relay APIs | Gelato, ZeroDev UltraRelay, Relay.link | Sponsored calls, some with free tiers |
| ERC-4337 paymasters | Pimlico, Alchemy Gas Manager, Coinbase CDP Paymaster, Biconomy, Candide, Etherspot, Particle, thirdweb | Verifying paymasters are sponsor-pays; ERC-20 paymasters pay gas in tokens |
| Pay gas in USDC | Circle Paymaster | For when there's no native gas token |
| Chain-native account abstraction | Abstract, zkSync | Paymasters built into the protocol |
| Solana fee payers | Kora | A relayer that pays SOL fees |
| Gasless swaps | CoW Swap, 0x Gasless, Uniswap (permit) | The solver or relayer pays gas |
| Platform-sponsored onboarding | Zora agents (`zora agent create`), Bankr | Identity, wallet, and first coin created at no cost |

## Repository layout

```
.
├── config/
│   └── treasury.json        treasury + ops wallet policy, hard caps
├── scripts/
│   ├── bootstrap.mjs        first-run: wallets + .env
│   ├── sync-skills.mjs      fetch/refresh the skills library
│   └── wallets.mjs          print addresses
├── skills/
│   ├── sources.json         every skill source (edit this)
│   ├── INDEX.md             generated catalog
│   ├── lock.json            resolved commits and fetch results
│   ├── vendor/              committed skills (permissive licenses)
│   └── external/            fetched at install (gitignored)
├── src/
│   └── keystore.mjs         encrypted local keystore
├── .env.example             every setting, all optional
└── .gitignore               written first: secrets never enter git
```

## Roadmap

1. **Foundation** *(done)*: gitignore, per-install wallets, treasury policy, skills library.
2. **Read everything**: multi-chain RPC layer and a scanner for contracts and platforms that pay callers (keeper bounties, harvest calls, liquidations, referral rewards, launch fees).
3. **Execute for free**: a router that sends each transaction through the cheapest sponsor available (Safe relayer, paymasters, gasless swaps) and falls back to self-paid gas only when the expected profit covers it.
4. **Treasury automation**: sweeping, top-ups, and bridging, enforced against `hardCaps`.
5. **Learn**: every attempt is logged as (state, action, cost, payout). The reward is **net profit per hour after gas, fees, and slippage**. Policy updates favour routes with higher ROI.
6. **Self-improve**: the agent proposes, backtests, and promotes changes to its own strategies. Promotion is gated on measured profit per hour, never on the agent's own claims.

## Guardrails

These rules aren't optional and exist to protect the treasury:

- **Only take payouts that are paid by design.** That means public incentive functions, bounties, rewards, and fees. Draining or exploiting bugged contracts is out of scope.
- **Follow each sponsor's terms and quotas.** Don't create sybil accounts to get around free-tier limits. A sponsor that bans the agent is a sponsor it has lost.
- **Hard caps are enforced in code**, and humans change them by hand.
- **Keys never leave the machine**, and they're never logged, printed, or sent to an LLM.
- **Profit is measured, not claimed.** Numbers come from onchain balances.
