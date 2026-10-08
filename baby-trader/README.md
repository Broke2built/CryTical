# baby-trader

16 autonomous trading wallets ("babies") for Zora coins on Base.

| I want to… | Read |
|---|---|
| run it, check on it, fix it | **RUN-IT.md** |
| change the code without breaking it | **CODEBASE.md** |
| understand why it's built this way | WREN-GUIDE.md, CLOUDFLARE-NOTES.md |
| find the source for a claim | REFERENCES.md |

```
npm install
npm test                       # 38 tests, no network, no money (includes the behavior lock)
npm run test:workerd           # the real bot inside Cloudflare's runtime, offline
npm run status -- --remote     # is the live bot healthy? (1 https call, no RPC)
npm run ops -- pause           # kill switch   (resume | ensure | tick | log | backup | restore)
npm run tournament / train     # simulations (no network)
```
