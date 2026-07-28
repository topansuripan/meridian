/**
 * Tests for fast-drop-guard.js — velocity-based recovery-exit for NORMAL positions.
 * Detects a sharp drop from a rolling high, then exits into a bounce / at breakeven /
 * at a hard floor rather than dumping at the bottom.
 * Run: node --test test-fast-drop-guard.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFastDropGuard } from "./fast-drop-guard.js";

const MIN = 60_000;
const CFG = {
  fastDropGuardEnabled: true,
  fastDropWindowMinutes: 15,
  fastDropTriggerPct: 15,
  fastDropBouncePct: 10,
  fastDropHardFloorPct: -25,
};
// helper: run a sequence of (minuteOffset, pnl_pct) ticks through the guard,
// threading the returned watch/samples forward. Returns the final result.
function run(seq, cfg = CFG) {
  let watch = null, samples = [];
  let res;
  for (const [min, pnl] of seq) {
    res = evaluateFastDropGuard({ samples, watch, currentPnlPct: pnl, now: min * MIN, cfg });
    watch = res.watch;
    samples = res.samples;
  }
  return res;
}

test("does not arm on a flat/slightly-up book", () => {
  const res = run([[0, 0], [5, 1], [10, 2], [15, 2.5]]);
  assert.equal(res.watch.active, false);
  assert.equal(res.action, null);
});

test("arms watch on a >=15% value drop from rolling high within the window", () => {
  // factor high = 1.05 (at +5%); drop to -12% => factor 0.88; 0.88/1.05-1 = -16.2% <= -15%
  const res = run([[0, 0], [3, 5], [6, -12]]);
  assert.equal(res.watch.active, true);
  assert.equal(res.action, null); // just armed, no exit yet
});

test("does NOT arm on a slow bleed spread beyond the window", () => {
  // high +2% at t=0 then -14% at t=30 — but t=0 sample has expired (window 15m),
  // so the rolling high at t=30 is only the recent samples, not the old +2%.
  const res = run([[0, 2], [20, -6], [30, -14]]);
  assert.equal(res.watch.active, false);
});

test("trails the low downward while watching", () => {
  const res = run([[0, 5], [6, -12], [8, -18]]);
  assert.equal(res.watch.active, true);
  // low factor should reflect the -18% tick (0.82), not the -12% arming tick
  assert.ok(Math.abs(res.watch.lowFactor - 0.82) < 1e-9);
});

test("exits on a >=10% bounce up from the recorded low", () => {
  // arm at -12% (factor .88), fall to -20% (low .80), bounce to -11% (factor .89)
  // .89/.80 - 1 = 11.25% >= 10% => exit
  const res = run([[0, 5], [6, -12], [8, -20], [10, -11]]);
  assert.equal(res.action, "FAST_DROP_EXIT");
  assert.match(res.reason, /bounce/i);
});

test("exits on return to breakeven", () => {
  const res = run([[0, 5], [6, -12], [10, 0]]);
  assert.equal(res.action, "FAST_DROP_EXIT");
  assert.match(res.reason, /breakeven/i);
});

test("force-closes at the hard floor while watching", () => {
  const res = run([[0, 5], [6, -12], [9, -26]]);
  assert.equal(res.action, "FAST_DROP_EXIT");
  assert.match(res.reason, /floor/i);
});

test("no-op when disabled", () => {
  const res = run([[0, 5], [6, -30]], { ...CFG, fastDropGuardEnabled: false });
  assert.equal(res.watch, null);
  assert.equal(res.action, null);
});

test("skips a tick with null pnl (never throws, no sample added)", () => {
  const res = evaluateFastDropGuard({
    samples: [{ ts: 0, factor: 1.05 }], watch: null, currentPnlPct: null, now: 60_000, cfg: CFG,
  });
  assert.equal(res.action, null);
  assert.equal(res.samples.length, 1); // unchanged
});
