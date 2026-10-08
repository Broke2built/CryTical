# baby-trader

16 autonomous trading wallets ("babies") for Zora coins on Base. **Start with `WREN-GUIDE.md`.**

```
npm install
npm test             # 19 tests, no network, no money
npm run tournament   # babies fight on a simulated thin AMM, survival of the fittest
npm run fork         # babies fight on a private Base fork with the real worker.js (needs foundry's anvil)
```

Live: `KEYS_FILE=... DRY_RUN=true node local-runner/run-tick.mjs` first, then without DRY_RUN.
