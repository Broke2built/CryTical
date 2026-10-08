// kv-local.mjs — file-backed shim for Cloudflare Workers KV.
//
// API mirrors the subset worker.js uses:
//   get(key) -> Promise<string|null>   (raw string value, null when missing)
//   put(key, value) -> Promise<void>   (value must be a string)
//   delete(key) -> Promise<void>
//   list() -> Promise<string[]>
//
// Persistence: a single JSON file {key: stringValue}. Atomic rename + fsync.
// Safe for one tick/minute from a single process (run-tick.mjs holds a process lock).
//
// (review) WRITE COALESCING — opt in with { deferNonCritical: true } (run-tick.mjs does).
// Every put used to rewrite + fsync the WHOLE ~700 KB store: a busy tick does ~240
// puts = ~85 MB rewritten and ~1.2 s of fsync; a quiet one ~60 puts / 40 MB. That is
// ~60 GB/day of rewrites on a home PC. With coalescing:
//   * MONEY-CRITICAL keys (positions, the write-ahead buy record, lastTrade, the tick
//     lock) are flushed to disk BEFORE put() resolves — exactly as before. Each flush
//     writes the whole store, so it also persists everything written before it.
//   * Everything else (stats, Q-tables, NN weights, logs, price history) is kept in
//     memory and flushed by flush() at the end of the tick (and on exit).
//   Crash mid-tick = you can lose that tick's non-critical updates since the last
//   critical write (some learning/stats). You can never lose a position record.
// Values written are identical either way; only WHEN they reach disk changes.

import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CRITICAL_KEY = /(^wallet:\d+:(position|pendingBuy|lastTrade)$)|(^meta:tickLock$)/;

export class LocalKV {
  constructor(filePath, { deferNonCritical = false } = {}) {
    if (!filePath) throw new Error('LocalKV requires a file path');
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.cache = null;
    this.defer = deferNonCritical;
    this.dirty = false;
    this.flushes = 0;
  }

  // Persist pending (deferred) writes. Safe to call any time; no-op when clean.
  flush() {
    if (this.dirty) this._save();
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
    this.dirty = false;
    this.flushes++;
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
    this.dirty = true;
    if (!this.defer || CRITICAL_KEY.test(key)) this._save();
  }

  async delete(key) {
    if (Object.prototype.hasOwnProperty.call(this._load(), key)) {
      delete this._load()[key];
      this.dirty = true;
      if (!this.defer || CRITICAL_KEY.test(key)) this._save();
    }
  }

  async list() {
    return Object.keys(this._load());
  }
}
