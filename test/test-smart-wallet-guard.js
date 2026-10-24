import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.smartWalletGuard is well-formed", () => {
  assert.equal(typeof config.smartWalletGuard.enabled, "boolean");
  const { minCount } = config.smartWalletGuard;
  assert.ok(Number.isInteger(minCount) && minCount >= 1);
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

function harness({ wallets = [W1, W2], positions = {}, failing = new Set(), mintFails = false, notifyThrows = false, poolMints = { ...POOL_MINTS }, mintCacheMax, listWallets } = {}) {
  let t = 1_000_000;
  const calls = { positions: [], mints: [], alerts: [], sleeps: [] };
  const state = { failing, mintFails };
  const checker = createPresenceChecker({
    listWallets: listWallets || (() => wallets),
    fetchPositionPools: async (addr) => {
      calls.positions.push(addr);
      if (state.failing.has(addr)) throw new Error("429 Too Many Requests");
      return positions[addr] || [];
    },
    fetchPoolMints: async (pools) => {
      calls.mints.push([...pools]);
      if (state.mintFails) throw new Error("rpc down");
      return new Map(pools.filter((p) => poolMints[p]).map((p) => [p, poolMints[p]]));
    },
    notify: async (text) => {
      if (notifyThrows) throw new Error("telegram down");
      calls.alerts.push(text);
    },
    now: () => t,
    sleep: async (ms) => { calls.sleeps.push(ms); },
    logger: () => {},
    ...(mintCacheMax != null ? { mintCacheMax } : {}),
  });
  return { checker, calls, state, wallets, poolMints, advance: (ms) => { t += ms; } };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const W3 = { name: "gamma", address: "Wallet4444444444444444444444444444444444444", type: "lp" };

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

test("lookups are spaced 250ms apart and not repeated inside the TTL", async () => {
  const { checker, calls } = harness({ wallets: [W1, W2, W3] });
  await checker.check({ baseMint: TOKEN });
  assert.deepEqual(calls.sleeps, [250, 250]);
  await checker.check({ baseMint: TOKEN });
  assert.deepEqual(calls.sleeps, [250, 250]);
});

test("a failed wallet is not retried inside the 60s backoff", async () => {
  const { checker, calls, advance } = harness({ failing: new Set([W1.address]) });
  const n = () => calls.positions.filter((a) => a === W1.address).length;
  await checker.check({ baseMint: TOKEN });
  advance(10_000);
  await checker.check({ baseMint: TOKEN });
  assert.equal(n(), 1);
  advance(61_000);
  await checker.check({ baseMint: TOKEN });
  assert.equal(n(), 2);
});

test("a pool whose mints were missing is re-resolved after 10 minutes", async () => {
  const { checker, calls, poolMints, advance } = harness({
    wallets: [W1], positions: { [W1.address]: ["P_NEW"] },
  });
  assert.equal((await checker.check({ baseMint: TOKEN })).kind, "none");
  poolMints.P_NEW = [TOKEN, SOL];
  advance(5 * MIN);
  assert.equal((await checker.check({ baseMint: TOKEN })).kind, "none");
  assert.equal(calls.mints.length, 1);
  advance(6 * MIN);
  assert.equal((await checker.check({ baseMint: TOKEN })).pass, true);
});

test("concurrent checks share one lookup per wallet", async () => {
  const { checker, calls } = harness();
  await Promise.all([checker.check({ baseMint: TOKEN }), checker.check({ baseMint: TOKEN })]);
  assert.equal(calls.positions.filter((a) => a === W1.address).length, 1);
  assert.equal(calls.positions.filter((a) => a === W2.address).length, 1);
});

test("duplicate wallet entries count once", async () => {
  const { checker } = harness({
    wallets: [W1, { ...W1, name: "alpha-dup" }],
    positions: { [W1.address]: ["P_TOKEN"] },
  });
  const r = await checker.check({ baseMint: TOKEN, minCount: 2 });
  assert.equal(r.kind, "none");
  assert.equal(r.count, 1);
});

test("a wallet with no type field counts as LP", async () => {
  const { name, address } = W1;
  const { checker } = harness({ wallets: [{ name, address }], positions: { [address]: ["P_TOKEN"] } });
  assert.equal((await checker.check({ baseMint: TOKEN })).pass, true);
});

test("missing base mint alerts once per 6h; a quote mint never alerts", async () => {
  const { checker, calls, advance } = harness();
  await checker.check({ baseMint: SOL });
  assert.equal(calls.alerts.length, 0);
  await checker.check({ baseMint: undefined });
  await checker.check({ baseMint: undefined });
  assert.equal(calls.alerts.length, 1);
  advance(6 * HOUR + 1);
  await checker.check({ baseMint: undefined });
  assert.equal(calls.alerts.length, 2);
});

test("minCount is coerced to a positive integer-ish value", async () => {
  const { checker } = harness();
  assert.equal((await checker.check({ baseMint: TOKEN, minCount: "2" })).required, 2);
  assert.equal((await checker.check({ baseMint: TOKEN, minCount: 0 })).required, 1);
  assert.equal((await checker.check({ baseMint: TOKEN, minCount: NaN })).required, 1);
});

test("mint cache cap clearing mid-call does not fail the lookup", async () => {
  const positions = { [W1.address]: ["P_TOKEN", "P_OTHER"] };
  const { checker, advance } = harness({ wallets: [W1], positions, mintCacheMax: 2 });
  assert.equal((await checker.check({ baseMint: TOKEN })).pass, true);
  positions[W1.address] = ["P_TOKEN", "P_FLIP"];
  advance(6 * MIN);
  const r = await checker.check({ baseMint: TOKEN });
  assert.equal(r.kind, "ok");
  assert.equal(r.pass, true);
});

test("a shared lookup that rejects falls back to stale cache for every waiter", async () => {
  const h = harness({ wallets: [W1], positions: { [W1.address]: ["P_TOKEN"] } });
  assert.equal((await h.checker.check({ baseMint: TOKEN })).pass, true);
  h.state.failing.add(W1.address);
  h.advance(10 * MIN);
  const rs = await Promise.all([1, 2, 3].map(() => h.checker.check({ baseMint: TOKEN })));
  assert.ok(rs.every((r) => r.pass === true));
  assert.equal(h.calls.positions.filter((a) => a === W1.address).length, 2);
});

import { evaluateSmartWalletGuard, fetchPositionPools, fetchPoolMints } from "../smart-wallets.js";
import { Keypair, PublicKey } from "@solana/web3.js";

async function withGuardConfig(patch, fn) {
  const saved = { ...config.smartWalletGuard };
  Object.assign(config.smartWalletGuard, patch);
  try { return await fn(); } finally { Object.assign(config.smartWalletGuard, saved); }
}
const explodingChecker = { check: async () => { throw new Error("checker must not run"); } };

test("evaluateSmartWalletGuard: disabled guard skips the check", async () => {
  await withGuardConfig({ enabled: false }, async () => {
    const r = await evaluateSmartWalletGuard({ baseMint: TOKEN }, explodingChecker);
    assert.equal(r.pass, true);
    assert.equal(r.kind, "disabled");
  });
});

test("evaluateSmartWalletGuard: degen deploys are exempt", async () => {
  await withGuardConfig({ enabled: true }, async () => {
    const r = await evaluateSmartWalletGuard({ baseMint: TOKEN, isDegen: true }, explodingChecker);
    assert.equal(r.pass, true);
    assert.equal(r.kind, "degen");
  });
});

test("evaluateSmartWalletGuard: enabled delegates with config minCount", async () => {
  await withGuardConfig({ enabled: true, minCount: 2 }, async () => {
    let seen = null;
    const checker = { check: async (args) => { seen = args; return { pass: false, kind: "none", matched: [] }; } };
    const r = await evaluateSmartWalletGuard({ baseMint: TOKEN }, checker);
    assert.equal(r.kind, "none");
    assert.equal(seen.baseMint, TOKEN);
    assert.equal(seen.minCount, 2);
  });
});

test("listWallets throwing -> list-error with one alert", async () => {
  const { checker, calls } = harness({ listWallets: () => { throw new Error("boom"); } });
  const r = await checker.check({ baseMint: TOKEN });
  assert.equal(r.pass, false);
  assert.equal(r.kind, "list-error");
  assert.ok(r.reason.includes("list (boom)"));
  assert.equal(calls.alerts.length, 1);
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.alerts.length, 1);
});

test("listWallets returning a non-array -> list-error", async () => {
  const { checker } = harness({ listWallets: () => ({}) });
  const r = await checker.check({ baseMint: TOKEN });
  assert.equal(r.kind, "list-error");
  assert.equal(r.pass, false);
});

test("junk list entries are skipped", async () => {
  const { checker } = harness({ listWallets: () => [null, { name: "x" }, W1], positions: { [W1.address]: [P("P_TOKEN")] } });
  const r = await checker.check({ baseMint: TOKEN });
  assert.equal(r.pass, true);
  assert.equal(r.matched[0].name, "alpha");
});

// ─── real fetchers with fake connections ───────────────────────
const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const POSITION_V2_B58 = "LgkNAEYaVX3";
const LB_PAIR_DISC = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);
const key = () => Keypair.generate().publicKey;

function lbPairInfo(x, y, { owner = DLMM, disc = LB_PAIR_DISC, size = 904 } = {}) {
  const data = Buffer.alloc(size);
  disc.copy(data, 0);
  if (size >= 152) { x.toBuffer().copy(data, 88); y.toBuffer().copy(data, 120); }
  return { owner: new PublicKey(owner), data };
}

test("fetchPoolMints reads mints at 88/120 and omits bad accounts", async () => {
  const pools = [key().toBase58(), key().toBase58(), key().toBase58(), key().toBase58()];
  const x = key(), y = key();
  const infos = [
    lbPairInfo(x, y),
    lbPairInfo(x, y, { owner: key().toBase58() }),
    lbPairInfo(x, y, { size: 100 }),
    lbPairInfo(x, y, { disc: Buffer.alloc(8, 1) }),
  ];
  const conn = { getMultipleAccountsInfo: async () => infos };
  const out = await fetchPoolMints(pools, conn);
  assert.deepEqual([...out.keys()], [pools[0]]);
  assert.deepEqual(out.get(pools[0]), [x.toBase58(), y.toBase58()]);
});

test("fetchPoolMints chunks 250 pools into 100/100/50", async () => {
  const pools = Array.from({ length: 250 }, () => key().toBase58());
  const sizes = [];
  const conn = { getMultipleAccountsInfo: async (ks) => { sizes.push(ks.length); return ks.map(() => null); } };
  const out = await fetchPoolMints(pools, conn);
  assert.deepEqual(sizes, [100, 100, 50]);
  assert.equal(out.size, 0);
});

test("fetchPositionPools filters by discriminator + owner, slices lbPair, dedupes", async () => {
  const owner = key().toBase58();
  const lb = key();
  let args = null;
  const conn = {
    getProgramAccounts: async (pid, cfg) => {
      args = { pid: pid.toBase58(), cfg };
      return [{ account: { data: lb.toBuffer() } }, { account: { data: Buffer.from(lb.toBuffer()) } }];
    },
  };
  const pools = await fetchPositionPools(owner, conn);
  assert.deepEqual(pools, [lb.toBase58()]);
  assert.equal(args.pid, DLMM);
  assert.deepEqual(args.cfg.dataSlice, { offset: 8, length: 32 });
  assert.deepEqual(args.cfg.filters, [
    { memcmp: { offset: 0, bytes: POSITION_V2_B58 } },
    { memcmp: { offset: 40, bytes: owner } },
  ]);
});

test("fetchPositionPools rejects an invalid owner before any RPC call", async () => {
  let called = false;
  const conn = { getProgramAccounts: async () => { called = true; return []; } };
  await assert.rejects(() => fetchPositionPools("not-a-key!", conn));
  assert.equal(called, false);
});
