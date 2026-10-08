# REFERENCES: sources behind every design decision

Links were checked on 2026-10-08. ✓ = loaded fine. ⓘ = exists, but the site blocks or rate-limits automated checks (GitHub, SSRN, some Uniswap pages); open it in a browser.

## Cloudflare (where the bot runs)
| Topic | Why it matters here | Link |
|---|---|---|
| Workers limits | Subrequests, CPU and memory per invocation (CLOUDFLARE-NOTES §1) | ✓ https://developers.cloudflare.com/workers/platform/limits/ |
| Workers pricing | Monthly request and KV costs | ✓ https://developers.cloudflare.com/workers/platform/pricing/ |
| KV limits | 1 write/sec/key, operations per invocation | ✓ https://developers.cloudflare.com/kv/platform/limits/ |
| How KV works | **Eventual consistency**: why positions could read stale | ✓ https://developers.cloudflare.com/kv/concepts/how-kv-works/ |
| Durable Object alarms | Why ticks can't overlap anymore | ✓ https://developers.cloudflare.com/durable-objects/api/alarms/ |
| Durable Object storage API | The strongly consistent store behind `DOStorageKV` | ✓ https://developers.cloudflare.com/durable-objects/api/storage-api/ |
| Durable Object limits | Value size, CPU per alarm | ✓ https://developers.cloudflare.com/durable-objects/platform/limits/ |
| DO migrations | Why `[[migrations]]` in wrangler.toml must never be edited after deploy | ✓ https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ |
| Cron triggers | The watchdog cron | ✓ https://developers.cloudflare.com/workers/configuration/cron-triggers/ |
| Wrangler configuration | `wrangler.toml` fields | ✓ https://developers.cloudflare.com/workers/wrangler/configuration/ |
| Secrets | `wrangler secret put`: keys never in files | ✓ https://developers.cloudflare.com/workers/configuration/secrets/ |
| Real-time logs | `npx wrangler tail` | ✓ https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ |

## Uniswap V4, Permit2, Base (the money path)
| Topic | Why | Link |
|---|---|---|
| V4 overview | PoolManager singleton, hooks, pool keys | ⓘ https://docs.uniswap.org/contracts/v4/overview |
| IPoolManager (Swap event) | The event `fetchSwapFlow` and spike attribution decode. **Signs are the trader's**, which we verified on real transactions in `test/fixtures/v4-swaps.json` | ✓ https://docs.uniswap.org/contracts/v4/reference/core/interfaces/IPoolManager |
| StateView | `getSlot0` / `getLiquidity` reads | ⓘ https://docs.uniswap.org/contracts/v4/guides/state-view |
| V4 deployments | Addresses of PoolManager, StateView, Quoter, Universal Router on Base | ✓ https://docs.uniswap.org/contracts/v4/deployments |
| v4-core source | Ground truth for the event and the BalanceDelta convention | ⓘ https://github.com/Uniswap/v4-core |
| Universal Router | What Zora's quote calldata calls | ✓ https://docs.uniswap.org/contracts/universal-router/overview |
| Permit2 | Sell approvals and signatures (`resolveSellPermits`) | ⓘ https://docs.uniswap.org/contracts/permit2/overview · ⓘ https://github.com/Uniswap/permit2 |
| EIP-712 | The typed-data signature Permit2 uses | ✓ https://eips.ethereum.org/EIPS/eip-712 |
| PoolManager on Basescan | Inspect real swaps when debugging | ✓ https://basescan.org/address/0x498581ff718922c3f8e6a244956af099b2652b2b |
| Base docs | Chain facts, fees, RPC providers | ✓ https://docs.base.org/ |
| Zora coins | Coin and pool model, the quote API's source | ✓ https://docs.zora.co/coins · ⓘ https://github.com/ourzora/zora-protocol |
| viem | The client library (`readContract`, `getLogs`) | ✓ https://viem.sh/docs/getting-started · ✓ https://viem.sh/docs/actions/public/getLogs · ✓ https://viem.sh/docs/contract/readContract |

## Learning, simulation, statistics
| Topic | Why | Link |
|---|---|---|
| Sutton & Barto, *Reinforcement Learning*, ch. 2 (bandits) | The babies' "Q-table" is a multi-armed bandit; ch. 2 covers epsilon-greedy, step sizes and the exploration cost of many arms | ✓ http://incompleteideas.net/book/the-book-2nd.html |
| Lattimore & Szepesvári, *Bandit Algorithms* | Deeper theory: regret, structured (factored) bandits | ✓ https://tor-lattimore.com/downloads/book/book.pdf |
| Russo et al., *A Tutorial on Thompson Sampling* | The recommended upgrade from epsilon-greedy for few-sample learning | ✓ https://arxiv.org/abs/1707.02038 |
| Laub, Taimre & Pollett, *Hawkes Processes* | The self-exciting trade-arrival model in `sim/synth.mjs` | ✓ https://arxiv.org/abs/1507.02822 |
| Bailey, Borwein, López de Prado, Zhu, *The Probability of Backtest Overfitting* | Why `sim/train.mjs` scores on HELD-OUT pools and refuses fake edges | ⓘ https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253 |

## Engineering practice
| Topic | Why | Link |
|---|---|---|
| Characterization (golden master) tests | How `test/golden` locks behavior during refactors | ✓ https://en.wikipedia.org/wiki/Characterization_test |
| Node test runner | `npm test` | ✓ https://nodejs.org/api/test.html |
| pm2 | Local fallback process manager | ✓ https://pm2.keymetrics.io/docs/usage/quick-start/ |

## Market integrity (the hard line)
| Topic | Why | Link |
|---|---|---|
| Wash trade (overview) | Why fleet-vs-fleet trading on a public pool is off-limits, whatever the intent | ✓ https://en.wikipedia.org/wiki/Wash_trade |
| Cong, Li, Tang, Yang, *Crypto Wash Trading* (NBER) | Evidence on how wash trading is detected on exchanges | ✓ https://www.nber.org/papers/w30783 |

## Verified in this repo (our own evidence)
- **V4 swap sign convention:** `test/fixtures/v4-swaps.json`, real Base buy and sell transactions, checked against their token transfers.
- **Per-tick costs** (subrequests, KV operations, CPU): `test/local-runner.test.mjs` budget test; numbers in `CLOUDFLARE-NOTES.md`.
- **Cloudflare runtime behavior:** `npm run test:workerd`.
- **Real order-flow statistics:** `sim/data/real-flow-*.json` via `sim/fetch-real.mjs`; findings in `WREN-GUIDE.md` §9.
