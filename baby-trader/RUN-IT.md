# RUN IT: the one-page manual

The bot runs on **Cloudflare**. Your PC only sends **one HTTPS request** when you check on it. It never makes RPC calls, so a wedged egress proxy on your side can't hurt the bot.

## 0. Once, on your PC
```bash
npm install
npm test                      # must say: pass 38, fail 0
npm run test:workerd          # must end with: PASS workerd
```

## 1. Once: deploy (Cloudflare)
```bash
cp wrangler.toml.example wrangler.toml          # keep DRY_RUN = "true" for now; put a keyed RPC first in RPC_URLS
npx wrangler login
npx wrangler secret put TICK_TOKEN              # make up a long random string; you'll need it below
npx wrangler secret put ZORA_API_KEY
for i in $(seq 0 15); do npx wrangler secret put BURNER_KEY_$i; done
npx wrangler deploy                              # prints https://baby-trader.<you>.workers.dev
```
Then tell your shell where it lives. Put these two lines in your shell profile so they're always set:
```bash
export WORKER_URL=https://baby-trader.<you>.workers.dev
export TICK_TOKEN=<the same string as the secret>
```

## 2. Once: move the old state over (keeps Q-tables, positions, stats)
```bash
npm run ops -- restore ~/workspace/cloudflare/slippy-trader/local-runner/kv-store.json
npm run ops -- ensure          # starts the tick loop
```
Stop the old local cron/loop **before** this, so two bots never trade the same wallets.

## 3. Every day (or let a scheduled task do it)
```bash
npm run status -- --remote            # ✅ / ⚠️ / ❌, and a FIX line for every problem
npm run status -- --remote --json     # same, for agents (exit 0 ok / 1 warn / 2 bad)
```

## 4. When something is wrong

| You see | Do |
|---|---|
| ❌ "No tick finished in N minutes" | `npm run ops -- ensure`, then check again in 2 min |
| ❌ "last N ticks failed" | `npm run ops -- log`; most often a missing secret (`npx wrangler secret list`) |
| ❌ "could not read the price" (SAFE-ABORT) | RPC trouble on Cloudflare's side: put a keyed RPC first in `RPC_URLS`, `npx wrangler deploy` |
| ⚠️ ORPHAN / GHOST | Usually nothing: the next live tick fixes it. Still there after 10 min → tell Wren/Claude |
| ⚠️ out of ETH | Fund those wallets on Base if you want them trading |
| Anything scary, or you're unsure | **`npm run ops -- pause`** (kill switch: trading stops, positions stay). Investigate, then `npm run ops -- resume` |
| You want to see live logs | `npx wrangler tail` |

## 5. Going live, and backing out
- **Live:** after a clean `DRY_RUN` day, set `DRY_RUN = "false"` in `wrangler.toml`, then `npx wrangler deploy`.
- **Backup any time:** `npm run ops -- backup` saves `backup-<time>.json`.
- **Bad deploy:** `npx wrangler rollback` (previous code), or `npm run ops -- pause`, then fix.
- **Restore state:** `npm run ops -- restore backup-<time>.json`.

## 6. Fallback: run on a PC instead (only if Cloudflare is unavailable)
```bash
KEYS_FILE=~/keys.json KV_FILE=~/baby/kv-store.json DRY_RUN=true TICK_FLOCK=/tmp/slippy-local-tick.lock \
  pm2 start local-runner/loop.mjs --name babies
npm run status                        # local mode (reads files + 1 small RPC batch; --offline = none)
```
This puts all RPC traffic back on that PC, so only use a machine with reliable internet.
