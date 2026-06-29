import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.screening has pump-guard defaults", () => {
  const s = config.screening;
  assert.equal(s.maxPump5mPct, 20);
  assert.equal(s.maxPump15mPct, 30);
  assert.equal(s.pumpLookbackHours, 2);
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectRecentPump, resolvePumpThreshold } from "../tools/screening.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(__dir, "fixtures", f), "utf8")).data;

test("detectRecentPump: ALON pre-entry window is flagged (the loss)", () => {
  const r = detectRecentPump(load("alon-pre-entry-5m.json"), { maxSingle5mPct: 20, max15mPct: 30 });
  assert.equal(r.pumped, true);
  assert.ok(r.maxSingle5mPct >= 24, `expected ~24.5, got ${r.maxSingle5mPct}`);
  assert.ok(r.max15mPct >= 40, `expected ~43, got ${r.max15mPct}`);
});

test("detectRecentPump: ALON post-dump window is NOT flagged", () => {
  const r = detectRecentPump(load("alon-post-dump-5m.json"), { maxSingle5mPct: 20, max15mPct: 30 });
  assert.equal(r.pumped, false);
});

test("detectRecentPump: +25% threshold would MISS ALON (single 24.5%)", () => {
  // Documents why we chose 20, not 25.
  const r = detectRecentPump(load("alon-pre-entry-5m.json"), { maxSingle5mPct: 25, max15mPct: 999 });
  assert.equal(r.pumped, false);
});

test("detectRecentPump: empty/insufficient candles never pumps", () => {
  assert.equal(detectRecentPump([], { maxSingle5mPct: 20, max15mPct: 30 }), null);
  assert.equal(detectRecentPump(null, { maxSingle5mPct: 20, max15mPct: 30 }), null);
});

test("detectRecentPump: disabled thresholds (null) never pump", () => {
  const r = detectRecentPump(load("alon-pre-entry-5m.json"), { maxSingle5mPct: null, max15mPct: null });
  assert.equal(r.pumped, false);
});

test("resolvePumpThreshold: null/undefined disable the guard (return null)", () => {
  assert.equal(resolvePumpThreshold(null), null);
  assert.equal(resolvePumpThreshold(undefined), null);
});

test("resolvePumpThreshold: numbers pass through; 0 is a real threshold; strings coerce", () => {
  assert.equal(resolvePumpThreshold(20), 20);
  assert.equal(resolvePumpThreshold(0), 0);
  assert.equal(resolvePumpThreshold("30"), 30);
  assert.equal(resolvePumpThreshold(NaN), null);
});

test("resolvePumpThreshold: degen-disabled path does NOT flag a pumped pool", () => {
  // Reproduces the degen screening path: overrides set the keys to null → must resolve to null
  // → detectRecentPump must NOT drop the candidate (guard disabled), even on the ALON pump window.
  const single = resolvePumpThreshold(null);
  const fifteen = resolvePumpThreshold(null);
  const r = detectRecentPump(load("alon-pre-entry-5m.json"), { maxSingle5mPct: single, max15mPct: fifteen });
  assert.equal(r.pumped, false);
});
