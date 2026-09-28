#!/usr/bin/env node
// Prints this install's wallet addresses and whether each key is encrypted.
// Never prints private keys.

import { readKeystore } from "../src/keystore.mjs";

const store = readKeystore();
if (!store) {
  console.error("No keystore yet. Run `npm run bootstrap`.");
  process.exit(1);
}
for (const w of store.wallets) {
  const enc = w.key.scheme === "plaintext" ? "UNENCRYPTED" : "encrypted";
  console.log(`${w.name.padEnd(9)} ${w.role.padEnd(8)} ${w.family}  ${w.address}  (${enc})`);
}
