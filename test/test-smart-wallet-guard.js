import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.smartWalletGuard defaults to off with minCount 1", () => {
  assert.equal(config.smartWalletGuard.enabled, false);
  assert.equal(config.smartWalletGuard.minCount, 1);
});

import { createPresenceChecker } from "../smart-wallets.js";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenMint1111111111111111111111111111111111";
const OTHER = "OtherMint1111111111111111111111111111111111";
const W1 = { name: "alpha", address: "Wallet1111111111111111111111111111111111111", type: "lp" };
const W2 = { name: "beta", address: "Wallet2222222222222222222222222222222222222", type: "lp" };
const HOLDER = { name: "hodl", address: "Wallet3333333333333333333333333333333333333", type: "holder" };

// P_TOKEN = TOKEN/SOL, P_OTHER = OTHER/SOL, P_FLIP = SOL/TOKEN (token on the Y side)
const POOL_MINTS = { P_TOKEN: [TOKEN, SOL], P_OTHER: [OTHER, SOL], P_FLIP: [SOL, TOKEN] };

function harness({ wallets = [W1, W2], positions = {}, failing = new Set(), mintFails = false, notifyThrows = false } = {}) {
  let t = 1_000_000;
  const calls = { positions: [], mints: [], alerts: [] };
  const state = { failing, mintFails };
  const checker = createPresenceChecker({
    listWallets: () => wallets,
    fetchPositionPools: async (addr) => {
      calls.positions.push(addr);
      if (state.failing.has(addr)) throw new Error("429 Too Many Requests");
      return positions[addr] || [];
    },
    fetchPoolMints: async (pools) => {
      calls.mints.push([...pools]);
      if (state.mintFails) throw new Error("rpc down");
      return new Map(pools.filter((p) => POOL_MINTS[p]).map((p) => [p, POOL_MINTS[p]]));
    },
    notify: async (text) => {
      if (notifyThrows) throw new Error("telegram down");
      calls.alerts.push(text);
    },
    now: () => t,
    sleep: async () => {},
  });
  return { checker, calls, state, wallets, advance: (ms) => { t += ms; } };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

test("passes when one tracked wallet LPs any pool of the token", async () => {
  const { checker } = harness({ positions: { [W1.address]: [P("P_TOKEN")] } });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, true);
  assert.equal(r.kind, "ok");
  assert.equal(r.count, 1);
  assert.equal(r.matched[0].name, "alpha");
});

test("token on the Y side of a pool counts as presence", async () => {
  const { checker } = harness({ positions: { [W2.address]: [P("P_FLIP")] } });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, true);
});

test("verified absence blocks as 'none' without an alert", async () => {
  const { checker, calls } = harness({ positions: { [W1.address]: [P("P_OTHER")] } });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, false);
  assert.equal(r.kind, "none");
  assert.equal(calls.alerts.length, 0);
});

test("minCount 2 needs two distinct wallets", async () => {
  const one = harness({ positions: { [W1.address]: [P("P_TOKEN")] } });
  assert.equal((await one.checker.check({ baseMint: TOKEN, minCount: 2 })).kind, "none");
  const two = harness({ positions: { [W1.address]: [P("P_TOKEN")], [W2.address]: [P("P_FLIP")] } });
  const r = await two.checker.check({ baseMint: TOKEN, minCount: 2 });
  assert.equal(r.pass, true);
  assert.equal(r.count, 2);
});

test("holder-type wallets are ignored (list counts as empty)", async () => {
  const { checker } = harness({ wallets: [HOLDER], positions: { [HOLDER.address]: [P("P_TOKEN")] } });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, false);
  assert.equal(r.kind, "empty");
});

test("missing or quote base mint blocks as 'no-mint'", async () => {
  const { checker } = harness({ positions: { [W1.address]: [P("P_TOKEN")] } });
  assert.equal((await checker.check({ baseMint: undefined })).kind, "no-mint");
  assert.equal((await checker.check({ baseMint: SOL })).kind, "no-mint");
});

// pool ids are plain strings in the fakes
function P(id) { return id; }
