// node:test — loss quarantine decision (evaluateLossQuarantine in pool-memory.js)
// Enforces the previously-dead risk.lossQuarantine* config keys.
// Gitignored per repo convention; run with: node --test test-pool-memory-loss-cooldown.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLossQuarantine } from "./pool-memory.js";

// VPS settings: a single stop-loss / -5% close quarantines for 24h
const VPS_CFG = {
  lossQuarantineTriggerCount: 1,
  lossQuarantineHours: 24,
  lossQuarantineMinPnlPct: -5,
};

const win = (pnl = 1.5) => ({ close_reason: "Trailing TP", pnl_pct: pnl });
const stopLoss = (pnl = -9.25) => ({ close_reason: "Stop loss: PnL -17.42% <= -5%", pnl_pct: pnl });

test("single stop-loss close quarantines (the HOME-SOL case, VPS config)", () => {
  const r = evaluateLossQuarantine([win(), stopLoss()], VPS_CFG);
  assert.ok(r, "expected quarantine");
  assert.equal(r.hours, 24);
  assert.match(r.reason, /quarantine/i);
});

test("stop-loss quarantines even when fee-offset PnL is above the pct threshold", () => {
  // febu closed -3.98% (fees offset the -5.31% SL trigger) — reason match must catch it
  const r = evaluateLossQuarantine([{ close_reason: "Stop loss: PnL -5.31% <= -5%", pnl_pct: -3.98 }], VPS_CFG);
  assert.ok(r);
});

test("deep net-loss close without stop-loss reason quarantines via pct", () => {
  const r = evaluateLossQuarantine([{ close_reason: "manual", pnl_pct: -6.5 }], VPS_CFG);
  assert.ok(r);
});

test("profitable close does NOT quarantine", () => {
  assert.equal(evaluateLossQuarantine([stopLoss(), win()], VPS_CFG), null);
});

test("small loss above minPnlPct does NOT quarantine", () => {
  assert.equal(evaluateLossQuarantine([{ close_reason: "low yield", pnl_pct: -0.5 }], VPS_CFG), null);
});

test("range events are exempt — OOR loss does NOT quarantine", () => {
  assert.equal(evaluateLossQuarantine([{ close_reason: "pumped far above range", pnl_pct: -6 }], VPS_CFG), null);
  assert.equal(evaluateLossQuarantine([{ close_reason: "Out of range for 45m", pnl_pct: -6 }], VPS_CFG), null);
});

test("triggerCount 2 needs two consecutive qualifying losses", () => {
  const cfg = { ...VPS_CFG, lossQuarantineTriggerCount: 2 };
  assert.equal(evaluateLossQuarantine([stopLoss()], cfg), null, "one loss, need two");
  assert.equal(evaluateLossQuarantine([stopLoss(), win(), stopLoss()], cfg), null, "win breaks the streak");
  assert.ok(evaluateLossQuarantine([win(), stopLoss(), stopLoss()], cfg), "two consecutive losses trigger");
});

test("defaults (2x / 24h / -8%) apply when keys missing", () => {
  assert.equal(evaluateLossQuarantine([stopLoss()], {}), null, "default triggerCount is 2");
  assert.ok(evaluateLossQuarantine([stopLoss(), stopLoss()], {}));
});

test("zero/negative hours or triggerCount disables quarantine", () => {
  assert.equal(evaluateLossQuarantine([stopLoss()], { ...VPS_CFG, lossQuarantineHours: 0 }), null);
  assert.equal(evaluateLossQuarantine([stopLoss()], { ...VPS_CFG, lossQuarantineTriggerCount: 0 }), null);
});

test("empty or too-short history does NOT quarantine", () => {
  assert.equal(evaluateLossQuarantine([], VPS_CFG), null);
  assert.equal(evaluateLossQuarantine(null, VPS_CFG), null);
});
