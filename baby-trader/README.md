# baby-trader

16 autonomous trading wallets ("babies") for Zora coins on Base. **Start with `WREN-GUIDE.md`.**

```
npm install
npm test             # 20 tests, no network, no money
npm run fetch-real   # pull real Base swap flow (accumulates in sim/data/)
npm run train        # parallel training on synthetic markets learned from real flow + out-of-sample exam
npm run tournament   # babies fight on a simulated thin AMM, survival of the fittest
npm run fork         # babies fight on a private Base fork with the real worker.js (needs foundry's anvil)
```

Live: `KEYS_FILE=... DRY_RUN=true node local-runner/run-tick.mjs` first, then without DRY_RUN.
