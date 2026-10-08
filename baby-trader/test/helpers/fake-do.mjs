// Minimal in-memory stand-in for Durable Object storage + state (the subset we use).
// Real API: https://developers.cloudflare.com/durable-objects/api/storage-api/
export class FakeDOStorage {
  constructor() { this.m = new Map(); this.alarm = null; }
  async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => this.m.has(x)).map((x) => [x, this.m.get(x)])) : this.m.get(k); }
  async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) this.m.set(a, b); else this.m.set(k, v); }
  async delete(k) { return this.m.delete(k); }
  async list() { return new Map([...this.m.entries()].sort()); }
  async getAlarm() { return this.alarm; }
  async setAlarm(t) { this.alarm = t; }
}
