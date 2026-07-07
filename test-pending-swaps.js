/**
 * Tests for pending-swaps.js — the persistent swap-back retry queue.
 * Run: node --test test-pending-swaps.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

// pending-swaps.js resolves its JSON file relative to cwd — run in a temp dir
const originalCwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-swaps-test-"));

let addPendingSwap, recordSwapAttempt, removePendingSwap, getPendingSwaps;

before(async () => {
  const mod = await import(pathToFileURL(path.join(originalCwd, "pending-swaps.js")).href);
  ({ addPendingSwap, recordSwapAttempt, removePendingSwap, getPendingSwaps } = mod);
  fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true }); // logger writes to ./logs
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MINT_A = "A1111111111111111111111111111111111111111111";
const MINT_B = "B2222222222222222222222222222222222222222222";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("starts empty", () => {
  assert.deepEqual(getPendingSwaps(), []);
});

test("addPendingSwap queues a mint and persists to disk", () => {
  const entry = addPendingSwap({ mint: MINT_A, symbol: "FOO", source: "close", reason: "tx not confirmed" });
  assert.equal(entry.mint, MINT_A);
  assert.equal(entry.symbol, "FOO");
  assert.equal(entry.attempts, 0);
  assert.ok(entry.firstSeen);

  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, "pending-swaps.json"), "utf8"));
  assert.ok(onDisk.pending[MINT_A]);
  assert.equal(getPendingSwaps().length, 1);
});

test("re-adding an existing mint keeps attempt history", () => {
  recordSwapAttempt(MINT_A, { error: "swap failed" });
  const entry = addPendingSwap({ mint: MINT_A, source: "close" });
  assert.equal(entry.attempts, 1);
  assert.equal(entry.symbol, "FOO");
  assert.equal(getPendingSwaps().length, 1);
});

test("refuses to queue SOL and USDC", () => {
  assert.equal(addPendingSwap({ mint: "SOL" }), null);
  assert.equal(addPendingSwap({ mint: SOL_MINT }), null);
  assert.equal(addPendingSwap({ mint: USDC_MINT }), null);
  assert.equal(addPendingSwap({ mint: null }), null);
  assert.equal(getPendingSwaps().length, 1);
});

test("recordSwapAttempt increments attempts and stores the error", () => {
  const entry = recordSwapAttempt(MINT_A, { error: "partial: 12.5 FOO still in wallet" });
  assert.equal(entry.attempts, 2);
  assert.equal(entry.lastError, "partial: 12.5 FOO still in wallet");
  assert.ok(entry.lastAttempt);
});

test("recordSwapAttempt on unknown mint is a no-op", () => {
  assert.equal(recordSwapAttempt(MINT_B, { error: "x" }), null);
});

test("removePendingSwap clears the entry", () => {
  addPendingSwap({ mint: MINT_B, symbol: "BAR", source: "claim" });
  assert.equal(getPendingSwaps().length, 2);
  assert.equal(removePendingSwap(MINT_A, "swapped"), true);
  assert.equal(removePendingSwap(MINT_A, "again"), false);
  const remaining = getPendingSwaps();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].mint, MINT_B);
});

test("survives a corrupt state file", () => {
  fs.writeFileSync(path.join(tmpDir, "pending-swaps.json"), "not json{{{");
  assert.deepEqual(getPendingSwaps(), []);
  const entry = addPendingSwap({ mint: MINT_A, symbol: "FOO" });
  assert.equal(entry.mint, MINT_A);
});
