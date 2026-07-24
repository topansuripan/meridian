// node:test — deploy-gate min-token-age check (getTokenAgeGateReason in tools/screening.js)
// Gitignored per repo convention; run with: node --test test-token-age-gate.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTokenAgeGateReason } from "./tools/screening.js";

const NOW = 1_800_000_000_000; // fixed epoch ms
const HOUR = 3_600_000;

test("token younger than minTokenAgeHours is blocked", () => {
  const detail = { token_x: { created_at: NOW - 20 * HOUR } }; // 20h old (the HOME/Bison case)
  const reason = getTokenAgeGateReason(detail, { minTokenAgeHours: 48 }, NOW);
  assert.ok(reason, "expected a block reason");
  assert.match(reason, /20\.0h.*48h/);
});

test("token older than minTokenAgeHours passes", () => {
  const detail = { token_x: { created_at: NOW - 72 * HOUR } };
  assert.equal(getTokenAgeGateReason(detail, { minTokenAgeHours: 48 }, NOW), null);
});

test("exactly at the threshold passes", () => {
  const detail = { token_x: { created_at: NOW - 48 * HOUR } };
  assert.equal(getTokenAgeGateReason(detail, { minTokenAgeHours: 48 }, NOW), null);
});

test("missing created_at never blocks (gate is lenient on missing data)", () => {
  assert.equal(getTokenAgeGateReason({ token_x: {} }, { minTokenAgeHours: 48 }, NOW), null);
  assert.equal(getTokenAgeGateReason({}, { minTokenAgeHours: 48 }, NOW), null);
  assert.equal(getTokenAgeGateReason(null, { minTokenAgeHours: 48 }, NOW), null);
});

test("minTokenAgeHours null/unset disables the check", () => {
  const detail = { token_x: { created_at: NOW - 1 * HOUR } };
  assert.equal(getTokenAgeGateReason(detail, { minTokenAgeHours: null }, NOW), null);
  assert.equal(getTokenAgeGateReason(detail, {}, NOW), null);
});

test("seconds-epoch created_at is normalized to ms", () => {
  const detail = { token_x: { created_at: (NOW - 20 * HOUR) / 1000 } }; // seconds
  const reason = getTokenAgeGateReason(detail, { minTokenAgeHours: 48 }, NOW);
  assert.ok(reason, "seconds-epoch should still block a 20h-old token");
});

test("ISO string created_at is accepted", () => {
  const detail = { token_x: { created_at: new Date(NOW - 20 * HOUR).toISOString() } };
  const reason = getTokenAgeGateReason(detail, { minTokenAgeHours: 48 }, NOW);
  assert.ok(reason);
});

test("falls back to base_token_created_at when token_x.created_at missing", () => {
  const detail = { base_token_created_at: NOW - 10 * HOUR };
  const reason = getTokenAgeGateReason(detail, { minTokenAgeHours: 48 }, NOW);
  assert.ok(reason);
});
