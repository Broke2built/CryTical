# Sim → Live Q-table merge-back plan (DRAFT — DO NOT EXECUTE without review)
# Written 2026-10-08 ~09:45 EDT. The main agent reviews and executes.

## What the sim produced
- `sim/sim-qtables.json`: 16 evolved Q-tables (same key format as live).
- `sim/sim-agg.json`: role/signal aggregates.
- `sim/sim-report.md`: findings (read first).

## Why NOT to copy sim tables over live tables directly
1. **Scale mismatch**: sim Q-values run +400..+1400 (74%-win-rate sim world);
   live Q-values run -150..+150 (real world, mostly losses). A direct overwrite
   would swamp every real lesson the babies earned onchain.
2. **Sim is optimistic**: no gas, 1%-per-side fees vs live gas on $0.16 trades,
   tight sim targets vs live 1.5x-gas bar, no NN veto in sim.
3. **Replay overfit**: 5000 episodes over ~725 unique price points (SLIPPY 587,
   BRAWL 138). The bandit memorized THESE windows.

## Recommended merge: structural lessons + normalized nudges
### Step 0 — safety (always)
1. `flock /tmp/slippy-local-tick.lock -c "..."` around ALL kv surgery.
2. `cp kv-store.json kv-store.backup-YYYYMMDD-HHMM.json` first.
3. Verify backup parses: `python3 -c "import json; json.load(open(...))"`.

### Step 1 — structural (code, not Q): the bottom-buy gate is poison
Sim: bottom signal 8% win rate, negative expectancy across all roles.
Live has the same gate (NEAR_LOW_PCT=10). Recommendation: derate — require
bottomBuy to ALSO pass belowTwap AND tickDropPct<5 (not just near-low), or
drop its priority below crash/value. This is a worker.js edit + deploy;
needs Anthony's eyes (two-head review, no Codex/Claude until 2026-10-12).

### Step 2 — normalized Q nudges (data, small)
For each wallet i:
1. Load live table L and sim table S.
2. Rank S's grid keys by Q; take top decile D+ and bottom decile D-.
3. For k in D+: L[k] = (L[k] ?? 0) + 15.  For k in D-: L[k] = (L[k] ?? 0) - 15.
   (±15 keeps live scale; live values are O(100).)
4. NEVER touch `baseline_unattributed`; never write `orphan_*` keys.
5. Write back under flock; log per-wallet {keysTouched, maxNudge}.

### Step 3 — verify
1. Re-read kv-store.json; confirm 16 tables parse, 433 keys each, one
   baseline_unattributed each, no orphan_ keys.
2. Confirm the live tick's next selectCombo runs (watch tick.log for
   `bandit EXPLOIT/EXPLORE` lines) — no poisoned combos.
3. Baby-monitor full-fleet parity check within 15 min.

### Step 4 — rollback
If any wallet misbehaves: restore from the Step-0 backup under flock,
confirm tick.log shows normal bandit lines.

## What NOT to merge
- Absolute sim Q-values (scale mismatch, §above).
- The momentum-buy signal (sim-only; worker.js has no such gate — needs a
  code change + review, not a Q-merge).
- First-jumper rush behavior (role overlay; live wallets are `patient` —
  rush was a sim training wheel, not a live strategy).
