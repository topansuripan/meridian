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

test("a failed lookup does not block when presence is already proven", async () => {
  const { checker } = harness({
    positions: { [W2.address]: ["P_TOKEN"] },
    failing: new Set([W1.address]),
  });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, true);
  assert.equal(r.failed[0].name, "alpha");
});

test("failed lookup without enough presence blocks as 'unverified'", async () => {
  const { checker } = harness({
    positions: { [W2.address]: ["P_OTHER"] },
    failing: new Set([W1.address]),
  });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, false);
  assert.equal(r.kind, "unverified");
});

test("pool-mint resolution failure counts as a failed lookup", async () => {
  const { checker } = harness({ positions: { [W1.address]: ["P_TOKEN"] }, mintFails: true });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.kind, "unverified");
});

test("per-wallet positions are cached for 5 minutes", async () => {
  const { checker, calls, advance } = harness({
    positions: { [W1.address]: ["P_OTHER"], [W2.address]: ["P_OTHER"] },
  });
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.positions.length, 2);
  advance(4 * MIN);
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.positions.length, 2, "no refetch inside TTL");
  advance(2 * MIN);
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.positions.length, 4, "refetch after TTL");
});

test("stale cache rides out a transient failure for up to 30 minutes", async () => {
  const h = harness({ wallets: [W1], positions: { [W1.address]: ["P_TOKEN"] } });
  assert.equal((await h.checker.check({ baseMint: TOKEN })).pass, true);
  h.state.failing.add(W1.address);
  h.advance(10 * MIN);
  assert.equal((await h.checker.check({ baseMint: TOKEN })).pass, true, "10m-old cache used");
  h.advance(25 * MIN); // cache now 35m old
  assert.equal((await h.checker.check({ baseMint: TOKEN })).kind, "unverified");
});

test("pool mints are resolved once and reused", async () => {
  const { checker, calls } = harness({
    positions: { [W1.address]: ["P_TOKEN", "P_OTHER"], [W2.address]: ["P_TOKEN"] },
  });
  await checker.check({ baseMint: TOKEN, minCount: 1, stopAtMinCount: false });
  assert.equal(calls.mints.length, 1);
  assert.deepEqual(calls.mints[0], ["P_TOKEN", "P_OTHER"]);
});

test("stops fetching wallets once minCount is met", async () => {
  const { checker, calls } = harness({
    positions: { [W1.address]: ["P_TOKEN"], [W2.address]: ["P_TOKEN"] },
  });
  await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.deepEqual(calls.positions, [W1.address]);
});

test("empty-list alert fires at most once per 6 hours", async () => {
  const { checker, calls, advance } = harness({ wallets: [] });
  await checker.check({ baseMint: TOKEN });
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.alerts.length, 1);
  advance(6 * HOUR + 1);
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.alerts.length, 2);
});

test("alert kinds are rate-limited independently", async () => {
  const h = harness({ wallets: [] });
  await h.checker.check({ baseMint: TOKEN }); // empty
  h.wallets.push(W1);
  h.state.failing.add(W1.address);
  await h.checker.check({ baseMint: TOKEN }); // unverified
  assert.equal(h.calls.alerts.length, 2);
  assert.match(h.calls.alerts[0], /no LP smart wallets/);
  assert.match(h.calls.alerts[1], /unverified/);
});

test("alert:false never notifies", async () => {
  const { checker, calls } = harness({ wallets: [] });
  await checker.check({ baseMint: TOKEN, alert: false });
  assert.equal(calls.alerts.length, 0);
});

test("a throwing notifier does not break the check", async () => {
  const { checker } = harness({ wallets: [], notifyThrows: true });
  const r = await checker.check({ baseMint: TOKEN });
  assert.equal(r.kind, "empty");
});
