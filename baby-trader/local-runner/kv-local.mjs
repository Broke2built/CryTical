// kv-local.mjs — file-backed shim for Cloudflare Workers KV.
//
// API mirrors the subset worker.js uses:
//   get(key) -> Promise<string|null>   (raw string value, null when missing)
//   put(key, value) -> Promise<void>   (value must be a string)
//   delete(key) -> Promise<void>
//   list() -> Promise<string[]>
//
// Persistence: a single JSON file {key: stringValue}. Write-through with
// atomic rename + fsync. Safe for one tick/minute from a single process;
// the worker's own KV tick-lock (meta:tickLock) prevents overlapping ticks.

import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class LocalKV {
  constructor(filePath) {
    if (!filePath) throw new Error('LocalKV requires a file path');
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.cache = null;
  }

  _load() {
    if (this.cache !== null) return this.cache;
    try {
      this.cache = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof this.cache !== 'object' || this.cache === null) this.cache = {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  _save() {
    const data = JSON.stringify(this._load());
    const tmp = this.filePath + '.tmp';
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
    // fsync the directory so the rename is durable
    const dfd = openSync(dirname(this.filePath), 'r');
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  }

  async get(key) {
    const store = this._load();
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  }

  async put(key, value) {
    if (typeof value !== 'string') {
      throw new Error(`LocalKV.put requires a string value for key "${key}"`);
    }
    this._load()[key] = value;
    this._save();
  }

  async delete(key) {
    if (Object.prototype.hasOwnProperty.call(this._load(), key)) {
      delete this._load()[key];
      this._save();
    }
  }

  async list() {
    return Object.keys(this._load());
  }
}
