// cloudflare.js — the Cloudflare entry point (wrangler.toml: main = "cloudflare.js").
// Cloudflare's runtime treats EVERY named export of the main module as an entrypoint and
// refuses to start on anything else ("Incorrect type for map entry 'BRAWL'"). worker.js
// also exports helpers for tests and scripts (BURNERS, BRAWL, __test, ...), so the
// deployable module re-exports ONLY the handlers and the Durable Object class.
export { default, TraderDO } from './worker.js';
