# Local runner — SLIPPY trader without Cloudflare

Runs `../worker.js` directly on this VM. Same `scheduled()` entry point the
Cloudflare cron used; state lives in a local JSON file instead of Workers KV.

## Files

- `kv-local.mjs` — file-backed KV shim (`get`/`put`/`delete`/`list`).
  Write-through with atomic rename + fsync. Single-process safe.
- `run-tick.mjs` — one tick. Builds a fake `env`, calls
  `worker.js`'s `scheduled()`, prints the tick log. Exit 0 on success.
- `migrate-kv.mjs` — one-time export of the Cloudflare KV namespace into
  `kv-store.json`. Read-only against Cloudflare. Refuses to overwrite a
  non-empty file without `--force`.
- `kv-store.json` — the local state (created by migrate-kv.mjs). chmod 600.

## Secrets

`KEYS_FILE` (env var, required, no default) points to a JSON file:

```json
{
  "BURNER_KEY_0": "0x...",
  "...": "...",
  "BURNER_KEY_15": "0x...",
  "ZORA_API_KEY": "..."
}
```

chmod 600. Values are never logged. The 16 burner keys + ZORA_API_KEY live
as Cloudflare secrets (write-only via API) — copy them from wherever they
were generated; they cannot be read back from Cloudflare.

## Commands

```bash
# one-time: export live state from Cloudflare KV (128 keys as of 2026-10-07)
cd ~/workspace/cloudflare/slippy-trader/local-runner
node migrate-kv.mjs

# one tick (dry-run: no broadcasts)
KEYS_FILE=/path/to/keys.json DRY_RUN=true node run-tick.mjs

# one live tick
KEYS_FILE=/path/to/keys.json node run-tick.mjs

# with explicit state file / RPCs
KV_FILE=/path/to/kv-store.json RPC_URLS="https://..." KEYS_FILE=... node run-tick.mjs
```

## DRY_RUN semantics (verified from worker.js)

- **Buy path**: `if (dryRun) return` (line ~773) runs BEFORE
  `privateKeyToAccount` (line ~775). Dummy keys are safe.
- **Sell path**: `privateKeyToAccount` (line ~909) runs BEFORE the DRY_RUN
  broadcast skip (line ~939). A tick that reaches a sell with an invalid key
  will throw at key parsing — DRY_RUN does not protect key loading there.
  Invalid keys are therefore a canary: if a dry tick crashes on
  `privateKeyToAccount`, it was about to sell.

## Notes

- `../node_modules` must contain `viem` (installed 2.57.3, satisfies ^2.37.0).
- The worker's KV tick-lock (`meta:tickLock`, 45s) prevents overlapping ticks.
- `cron-test:lastFire` in kv-store.json is residue from a Cloudflare cron
  diagnostic on 2026-10-07 — inert, safe to delete.
