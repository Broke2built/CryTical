#!/usr/bin/env node
// First-run setup for a fresh install. Safe to re-run: it never replaces
// an existing wallet.
//
//   1. Creates .env from .env.example (if missing).
//   2. Generates this install's wallets in .wallets/keystore.json:
//        treasury  EVM  — the one central wallet. All earnings end here.
//        ops-evm   EVM  — hot wallet that signs day-to-day EVM activity.
//        ops-sol   SVM  — hot wallet for Solana activity.
//      Ops wallets hold only what the treasury policy lets them hold.
//   3. Writes the public addresses into .env.
//
// Flags:
//   --encrypt   re-encrypt any plaintext keys using CRYTICAL_KEYSTORE_PASSPHRASE

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ROOT, KEYSTORE_PATH, readKeystore, writeKeystore, encryptSecret, decryptSecret } from "../src/keystore.mjs";

const WALLETS = [
  { name: "treasury", role: "treasury", family: "evm" },
  { name: "ops-evm", role: "ops", family: "evm" },
  { name: "ops-sol", role: "ops", family: "svm" },
];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = "1" + out; }
  return out;
}

function newEvm() {
  const pk = generatePrivateKey();
  return { address: privateKeyToAccount(pk).address, secret: pk };
}

function newSolana() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  // Solana's 64-byte secret key format: seed || public key.
  return { address: base58(pub), secret: base58(Buffer.concat([seed, pub])) };
}

function ensureEnv(addresses) {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(path.join(ROOT, ".env.example"), envPath);
    fs.chmodSync(envPath, 0o600);
    console.log("created .env from .env.example");
  }
  let env = fs.readFileSync(envPath, "utf8");
  const set = (k, v) => {
    const re = new RegExp(`^${k}=.*$`, "m");
    env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + `\n${k}=${v}\n`;
  };
  set("TREASURY_ADDRESS", addresses.treasury);
  set("OPS_EVM_ADDRESS", addresses["ops-evm"]);
  set("OPS_SOL_ADDRESS", addresses["ops-sol"]);
  fs.writeFileSync(envPath, env);
}

const store = readKeystore() ?? { version: 1, createdAt: new Date().toISOString(), wallets: [] };
const reencrypt = process.argv.includes("--encrypt");
if (reencrypt && !process.env.CRYTICAL_KEYSTORE_PASSPHRASE) {
  console.error("--encrypt needs CRYTICAL_KEYSTORE_PASSPHRASE set");
  process.exit(1);
}

let created = 0;
for (const spec of WALLETS) {
  const existing = store.wallets.find((w) => w.name === spec.name);
  if (existing) {
    if (reencrypt && existing.key.scheme === "plaintext") {
      existing.key = encryptSecret(decryptSecret(existing.key));
      console.log(`encrypted  ${spec.name}`);
    }
    continue;
  }
  const { address, secret } = spec.family === "evm" ? newEvm() : newSolana();
  store.wallets.push({ ...spec, address, createdAt: new Date().toISOString(), key: encryptSecret(secret) });
  created++;
  console.log(`generated  ${spec.name.padEnd(9)} ${spec.family}  ${address}`);
}
writeKeystore(store);

const addresses = Object.fromEntries(store.wallets.map((w) => [w.name, w.address]));
ensureEnv(addresses);

console.log(`\n${created ? `${created} new wallet(s) created.` : "Wallets already exist; nothing regenerated."}`);
console.log(`keystore: ${path.relative(ROOT, KEYSTORE_PATH)} (gitignored)`);
if (store.wallets.some((w) => w.key.scheme === "plaintext")) {
  console.log("\nWARNING: keys are stored UNENCRYPTED. Set CRYTICAL_KEYSTORE_PASSPHRASE and run `npm run bootstrap -- --encrypt`.");
}
console.log("\nBack up .wallets/ offline now. Lose it and the funds are gone. Never commit it.");
