/**
 * Tests for the tolerant closed-PnL entry matcher in tools/dlmm.js.
 * The Meteora datapi returns the position identifier under different keys
 * (positionAddress / address / position) and containers (positions / data);
 * a match that only handled "positionAddress" left closed PnL stuck at 0%.
 * Run: node --test test-dlmm-pnl.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { findClosedPnlEntry } from "./tools/dlmm.js";

const POS = "PoSaddr1111111111111111111111111111111111111";
const OTHER = "OtherPos2222222222222222222222222222222222222";

test("matches the canonical 'positionAddress' field shape", () => {
  const data = {
    positions: [
      { positionAddress: OTHER, pnlUsd: 1, pnlPctChange: 5 },
      { positionAddress: POS, pnlUsd: 12.5, pnlPctChange: 8.4 },
    ],
  };
  const entry = findClosedPnlEntry(data, POS);
  assert.ok(entry);
  assert.equal(entry.pnlPctChange, 8.4);
});

test("matches the 'position' field shape (datapi variant)", () => {
  const data = {
    positions: [{ position: POS, pnlUsd: -3.1, pnlPctChange: -2.2 }],
  };
  const entry = findClosedPnlEntry(data, POS);
  assert.ok(entry);
  assert.equal(entry.pnlPctChange, -2.2);
});

test("matches the 'address' field shape", () => {
  const data = {
    positions: [{ address: POS, pnlUsd: 4, pnlPctChange: 1.1 }],
  };
  const entry = findClosedPnlEntry(data, POS);
  assert.ok(entry);
  assert.equal(entry.pnlPctChange, 1.1);
});

test("matches when positions live under the 'data' container", () => {
  const data = {
    data: [{ position: POS, pnlUsd: 9, pnlPctChange: 3.3 }],
  };
  const entry = findClosedPnlEntry(data, POS);
  assert.ok(entry);
  assert.equal(entry.pnlPctChange, 3.3);
});

test("returns undefined when the position is absent", () => {
  const data = { positions: [{ position: OTHER, pnlPctChange: 5 }] };
  assert.equal(findClosedPnlEntry(data, POS), undefined);
});

test("does not throw on empty/missing payloads", () => {
  assert.equal(findClosedPnlEntry({}, POS), undefined);
  assert.equal(findClosedPnlEntry(null, POS), undefined);
});
