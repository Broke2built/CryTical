// fake-chain.mjs — an in-memory Base + Zora quote API, installed by replacing
// globalThis.fetch. Lets tests run REAL worker.js ticks (buy, hold, sell, Q-update)
// with zero network and zero money. Every JSON-RPC method the worker uses is served
// here; anything unexpected throws so the test fails loudly instead of hanging.
import { toFunctionSelector, parseTransaction, keccak256, encodeAbiParameters } from 'viem';

const SEL = {
  getSlot0: toFunctionSelector('getSlot0(bytes32)'),
  getLiquidity: toFunctionSelector('getLiquidity(bytes32)'),
  balanceOf: toFunctionSelector('balanceOf(address)'),
  allowance: toFunctionSelector('allowance(address,address)'),
  permit2Allowance: toFunctionSelector('allowance(address,address,address)'),
};
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const hex = (v) => '0x' + BigInt(v).toString(16);
const Q96 = 2n ** 96n;

export class FakeChain {
  constructor({ priceWeth = 1e-8, ethUsd = 3000 } = {}) {
    this.ethUsd = ethUsd;
    this.setPrice(priceWeth);
    this.eth = new Map();     // addr(lower) -> wei
    this.tokens = new Map();  // addr(lower) -> token wei
    this.gasPrice = 10_000_000n; // 0.01 gwei (Base-like)
    this.block = 52_400_000n;
    this.sellQuoteMult = 1.0;    // sell quote = tokens * price * mult (lets tests force profit)
    this.calls = [];
    this.sent = [];
    this.receipts = new Map();
    this.swapLogs = [];          // craftable Swap logs (spike-attribution tests)
    this.txByHash = new Map();   // txHash(lower) -> { from }
  }
  setPrice(p) {
    // sqrtPriceX96 = sqrt(price) * 2^96  (sq = sqrtPriceX96^2 is LINEAR in price)
    this.priceWeth = p;
    this.sqrtPriceX96 = BigInt(Math.round(Math.sqrt(p) * 2 ** 48)) * 2n ** 48n;
  }
  bal(map, a) { return map.get(a.toLowerCase()) ?? 0n; }
  rpc(method, params) {
    this.calls.push(method);
    switch (method) {
      case 'eth_chainId': return '0x2105';
      case 'eth_blockNumber': return hex(this.block);
      case 'eth_gasPrice': return hex(this.gasPrice);
      case 'eth_getLogs': return this.swapLogs;
      case 'eth_getTransactionByHash': {
        const t = this.txByHash.get(String(params[0]).toLowerCase());
        if (!t) throw new Error(`FakeChain: unknown tx ${params[0]}`);
        return t;
      }
      case 'eth_estimateGas': return hex(150000);
      case 'eth_getTransactionCount': return hex(this.sent.length);
      case 'eth_getBalance': return hex(this.bal(this.eth, params[0]));
      case 'eth_call': return this.call(params[0]);
      case 'eth_sendRawTransaction': return this.send(params[0]);
      case 'eth_getTransactionReceipt': return this.receipts.get(params[0]) ?? null;
      default: throw new Error(`FakeChain: unexpected RPC ${method}`);
    }
  }
  call({ data }) {
    const sel = data.slice(0, 10);
    const arg = (k) => '0x' + data.slice(10 + 64 * k + 24, 10 + 64 * (k + 1));
    if (sel === SEL.getSlot0) return '0x' + word(this.sqrtPriceX96) + word(0) + word(0) + word(0);
    if (sel === SEL.getLiquidity) return '0x' + word(10n ** 21n);
    if (sel === SEL.balanceOf) return '0x' + word(this.bal(this.tokens, arg(0)));
    if (sel === SEL.allowance) return '0x' + word(2n ** 256n - 1n);
    if (sel === SEL.permit2Allowance) return '0x' + word(0) + word(0) + word(0);
    throw new Error(`FakeChain: unexpected eth_call selector ${sel}`);
  }
  // Quote calldata carries the intent: 0xb0 + wallet = buy, 0x5e + wallet = sell.
  send(raw) {
    const tx = parseTransaction(raw);
    const hash = keccak256(raw);
    const kind = tx.data.slice(0, 4);
    const who = '0x' + tx.data.slice(4, 44);
    const gasWei = 150000n * this.gasPrice;
    this.eth.set(who.toLowerCase(), this.bal(this.eth, who) - gasWei - (tx.value ?? 0n));
    if (kind === '0xb0') {
      const tokens = BigInt(Math.floor(Number(tx.value) / this.priceWeth));
      this.tokens.set(who.toLowerCase(), this.bal(this.tokens, who) + tokens);
    } else if (kind === '0x5e') {
      const amt = BigInt('0x' + tx.data.slice(44, 108));
      const out = BigInt(Math.floor(Number(amt) * this.priceWeth * this.sellQuoteMult));
      this.tokens.set(who.toLowerCase(), this.bal(this.tokens, who) - amt);
      this.eth.set(who.toLowerCase(), this.bal(this.eth, who) + out);
    }
    this.sent.push({ kind, who, hash });
    this.receipts.set(hash, { status: '0x1', blockNumber: hex(this.block), gasUsed: hex(150000) });
    this.block += 1n;
    return hash;
  }
  quote(body) {
    const sender = body.sender.slice(2).toLowerCase();
    const amt = BigInt(body.amountIn);
    if (body.tokenIn.type === 'eth') {
      return { success: true, call: { target: '0x00000000000000000000000000000000000000aa', data: '0xb0' + sender, value: amt.toString() },
        quote: { amountOut: String(Math.floor(Number(amt) / this.priceWeth)) } };
    }
    return { success: true, call: { target: '0x00000000000000000000000000000000000000aa', data: '0x5e' + sender + word(amt), value: '0' },
      quote: { amountOut: String(Math.floor(Number(amt) * this.priceWeth * this.sellQuoteMult)) } };
  }
  install() {
    const self = this;
    this._orig = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
      if (u.includes('api-sdk.zora.engineering/quote')) return json(self.quote(JSON.parse(init.body)));
      if (u.includes('coinbase')) return json({ data: { amount: String(self.ethUsd) } });
      if (u.includes('coingecko')) return json({ ethereum: { usd: self.ethUsd } });
      if (u.includes('kraken')) return json({ result: { XETHZUSD: { c: [String(self.ethUsd)] } } });
      if (u.startsWith('http://fake-rpc')) {
        const body = JSON.parse(init.body);
        const one = (r) => {
          try { return { jsonrpc: '2.0', id: r.id, result: self.rpc(r.method, r.params) }; }
          catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: e.message } }; }
        };
        return json(Array.isArray(body) ? body.map(one) : one(body));
      }
      throw new Error(`FakeChain: unexpected fetch ${u}`);
    };
    return this;
  }
  uninstall() { globalThis.fetch = this._orig; }
}

export class MemKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  json(k) { const v = this.m.get(k); return v == null ? null : JSON.parse(v); }
  set(k, v) { this.m.set(k, JSON.stringify(v)); }
}

export const sqFor = (priceWeth) => {
  const s = BigInt(Math.round(Math.sqrt(priceWeth) * 2 ** 48)) * 2n ** 48n;
  return s * s;
};
export { keccak256, encodeAbiParameters, Q96 };
