// Local keystore for the agent's wallets.
//
// Everything lives in .wallets/ (gitignored). Private keys are encrypted
// with scrypt + AES-256-GCM when CRYTICAL_KEYSTORE_PASSPHRASE is set;
// otherwise they are stored in plaintext with 0600 permissions and every
// load prints a warning.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WALLET_DIR = path.join(ROOT, ".wallets");
export const KEYSTORE_PATH = path.join(WALLET_DIR, "keystore.json");
export const ADDRESSES_PATH = path.join(WALLET_DIR, "addresses.json");

const SCRYPT = { N: 1 << 14, r: 8, p: 1, keylen: 32 };

function passphrase() {
  const p = process.env.CRYTICAL_KEYSTORE_PASSPHRASE;
  return p && p.length ? p : null;
}

export function encryptSecret(secret) {
  const pass = passphrase();
  if (!pass) return { scheme: "plaintext", secret };
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    scheme: "scrypt-aes-256-gcm",
    kdf: { ...SCRYPT, salt: salt.toString("hex") },
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ct.toString("hex"),
  };
}

export function decryptSecret(box) {
  if (box.scheme === "plaintext") return box.secret;
  const pass = passphrase();
  if (!pass) throw new Error("Keystore is encrypted: set CRYTICAL_KEYSTORE_PASSPHRASE");
  const { N, r, p, keylen, salt } = box.kdf;
  const key = crypto.scryptSync(pass, Buffer.from(salt, "hex"), keylen, { N, r, p });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "hex"));
  decipher.setAuthTag(Buffer.from(box.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, "hex")), decipher.final()]).toString("utf8");
}

export function readKeystore() {
  if (!fs.existsSync(KEYSTORE_PATH)) return null;
  return JSON.parse(fs.readFileSync(KEYSTORE_PATH, "utf8"));
}

export function writeKeystore(store) {
  fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEYSTORE_PATH, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  const addresses = Object.fromEntries(
    store.wallets.map((w) => [w.name, { role: w.role, family: w.family, address: w.address }]),
  );
  fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(addresses, null, 2) + "\n", { mode: 0o600 });
}

// Returns { name, role, family, address, secret }. `secret` is a 0x-hex
// private key for EVM wallets, or a base58 64-byte secret key for Solana.
export function loadWallet(name) {
  const store = readKeystore();
  if (!store) throw new Error("No keystore found: run `npm run bootstrap` first");
  const w = store.wallets.find((x) => x.name === name);
  if (!w) throw new Error(`No wallet named "${name}" in keystore`);
  if (w.key.scheme === "plaintext") {
    console.warn(`[keystore] WARNING: "${name}" is stored unencrypted. Set CRYTICAL_KEYSTORE_PASSPHRASE and re-run bootstrap --encrypt.`);
  }
  return { name: w.name, role: w.role, family: w.family, address: w.address, secret: decryptSecret(w.key) };
}
