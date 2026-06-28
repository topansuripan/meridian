import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.solCrashGuard has sane defaults", () => {
  const c = config.solCrashGuard;
  assert.ok(c, "solCrashGuard section exists");
  assert.equal(c.enabled, true);
  assert.equal(c.drop1hPct, 3);
  assert.equal(c.drawdown6hPct, 5);
  assert.equal(c.cooldownHours, 6);
  assert.equal(c.reentryRequiresStable, true);
  assert.equal(c.scope, "normal");
  assert.equal(typeof c.keepGasReserveSol, "number");
  assert.equal(c.backfillOnStart, true);
});

import { computeSolMetrics, isDumping } from "../sol-crash-guard.js";

const HOUR = 3600_000;
// helper: build hourly [ms, price] history ending at `end`, oldest first
function hist(prices, end) {
  return prices.map((p, i) => [end - (prices.length - 1 - i) * HOUR, p]);
}
const CFG = { drop1hPct: 3, drawdown6hPct: 5 };

test("computeSolMetrics: flat market is not dumping", () => {
  const end = 10_000_000_000_000;
  const h = hist([67, 67, 67, 67, 67, 67, 67], end);
  const m = computeSolMetrics(h, end);
  assert.equal(m.hasEnoughHistory, true);
  assert.ok(Math.abs(m.drop1h) < 0.01);
  assert.ok(Math.abs(m.drawdown6h) < 0.01);
  assert.equal(isDumping(m, CFG).dumping, false);
});

test("computeSolMetrics: sharp 1h drop trips drop1h", () => {
  const end = 10_000_000_000_000;
  const h = hist([68, 68, 68, 68, 68, 68, 64.9], end); // -4.56% last hour
  const m = computeSolMetrics(h, end);
  assert.ok(m.drop1h <= -3, `drop1h=${m.drop1h}`);
  const d = isDumping(m, CFG);
  assert.equal(d.dumping, true);
  assert.match(d.reason, /1h/);
});

test("computeSolMetrics: slow 6h bleed trips drawdown6h", () => {
  const end = 10_000_000_000_000;
  // high 69.3 six hours ago, grinding down to 65.5 now (~-5.5% off high), no single -3% hour
  const h = hist([69.3, 68.6, 67.9, 67.2, 66.5, 65.9, 65.5], end);
  const m = computeSolMetrics(h, end);
  assert.ok(m.drop1h > -3, `drop1h=${m.drop1h} should not trip 1h`);
  assert.ok(m.drawdown6h <= -5, `drawdown6h=${m.drawdown6h}`);
  assert.equal(isDumping(m, CFG).dumping, true);
});

test("computeSolMetrics: insufficient history never dumps", () => {
  const end = 10_000_000_000_000;
  const h = [[end - 10 * 60_000, 70], [end, 64]]; // only 10 min of data
  const m = computeSolMetrics(h, end);
  assert.equal(m.hasEnoughHistory, false);
  assert.equal(isDumping(m, CFG).dumping, false);
});

import { pushPrice } from "../sol-crash-guard.js";

test("pushPrice appends, sorts, and trims to maxAge", () => {
  const now = 10_000_000_000_000;
  const maxAge = 7 * 3600_000;
  let h = [];
  h = pushPrice(h, 67, now - 8 * 3600_000, maxAge); // older than maxAge -> trimmed on next push
  h = pushPrice(h, 66, now - 1 * 3600_000, maxAge);
  h = pushPrice(h, 65, now, maxAge);
  assert.equal(h.length, 2, "stale 8h-old sample dropped");
  assert.deepEqual(h.map(p => p[1]), [66, 65]);
  // ignores non-finite price
  const before = h.length;
  h = pushPrice(h, NaN, now + 1000, maxAge);
  assert.equal(h.length, before);
});

import { defaultState, loadState, saveState } from "../sol-crash-guard.js";
import fs from "node:fs";

test("defaultState shape", () => {
  const s = defaultState();
  assert.deepEqual(s.priceHistory, []);
  assert.equal(s.breaker.active, false);
  assert.equal(s.breaker.cooldownUntil, null);
});

test("saveState/loadState round-trip with explicit path", () => {
  const p = "./test/.tmp-sol-state.json";
  const s = defaultState();
  s.breaker.active = true;
  s.breaker.reason = "test";
  saveState(s, p);
  const loaded = loadState(p);
  assert.equal(loaded.breaker.active, true);
  assert.equal(loaded.breaker.reason, "test");
  fs.unlinkSync(p);
});

test("loadState returns defaults when file missing", () => {
  const loaded = loadState("./test/.does-not-exist.json");
  assert.equal(loaded.breaker.active, false);
});

import { maybeTrip } from "../sol-crash-guard.js";

function mkDeps(overrides = {}) {
  const closed = [];
  return {
    closed,
    getNormalOpenPositions: async () => [
      { position: "P1", pool_name: "AAA-SOL" },
      { position: "P2", pool_name: "BBB-SOL" },
    ],
    closePosition: async ({ position_address }) => { closed.push(position_address); return { ok: true }; },
    swapSolToUsdc: async () => ({ usdcOut: 150 }),
    notify: async () => {},
    ...overrides,
  };
}
const CFG_FULL = { enabled: true, drop1hPct: 3, drawdown6hPct: 5, cooldownHours: 6, scope: "normal" };

test("maybeTrip closes normal positions and parks USDC when dumping", async () => {
  const now = 10_000_000_000_000;
  const s = defaultState();
  s.priceHistory = hist([68, 68, 68, 68, 68, 68, 64.9], now); // -4.56% 1h
  const deps = mkDeps();
  await maybeTrip(s, { now, cfg: CFG_FULL, deps });
  assert.equal(s.breaker.active, true);
  assert.deepEqual(deps.closed.sort(), ["P1", "P2"]);
  assert.equal(s.breaker.usdcParked, 150);
  assert.equal(s.breaker.cooldownUntil, now + 6 * 3600_000);
  assert.match(s.breaker.reason, /1h/);
});

test("maybeTrip is a no-op on a flat market", async () => {
  const now = 10_000_000_000_000;
  const s = defaultState();
  s.priceHistory = hist([67, 67, 67, 67, 67, 67, 67], now);
  const deps = mkDeps();
  await maybeTrip(s, { now, cfg: CFG_FULL, deps });
  assert.equal(s.breaker.active, false);
  assert.equal(deps.closed.length, 0);
});

test("maybeTrip is a no-op when already active", async () => {
  const now = 10_000_000_000_000;
  const s = defaultState();
  s.breaker.active = true;
  s.priceHistory = hist([68, 68, 68, 68, 68, 68, 64.9], now);
  const deps = mkDeps();
  await maybeTrip(s, { now, cfg: CFG_FULL, deps });
  assert.equal(deps.closed.length, 0, "must not double-close");
});

test("maybeTrip continues past a single close failure", async () => {
  const now = 10_000_000_000_000;
  const s = defaultState();
  s.priceHistory = hist([68, 68, 68, 68, 68, 68, 64.9], now);
  const deps = mkDeps({
    closePosition: async ({ position_address }) => {
      if (position_address === "P1") throw new Error("tx failed");
      return { ok: true };
    },
  });
  await maybeTrip(s, { now, cfg: CFG_FULL, deps });
  assert.equal(s.breaker.active, true, "still trips");
  assert.ok(s.breaker.closedPositions.includes("P2"));
});
