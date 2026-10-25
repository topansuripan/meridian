import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPositions, listedPositions, createManualAlerter, manualGuardReason } from "../manual-positions.js";

const A = { position: "AAAA1111", pair: "A/SOL" };
const B = { position: "BBBB2222", pair: "B/SOL" };
const C = { position: "CCCC3333", pair: "C/SOL" };

test("split: tracked positions are the bot's, the rest are manual", () => {
  const { bot, manual } = splitPositions([A, B, C], new Set(["AAAA1111", "CCCC3333"]));
  assert.deepEqual(bot, [A, C]);
  assert.deepEqual(manual, [B]);
});

test("split: unreadable state (null set) keeps every position as the bot's", () => {
  const { bot, manual } = splitPositions([A, B], null);
  assert.deepEqual(bot, [A, B]);
  assert.deepEqual(manual, []);
});

test("listedPositions: bot positions first, then manual; tolerates missing arrays", () => {
  assert.deepEqual(listedPositions({ positions: [A], manual_positions: [B] }), [A, B]);
  assert.deepEqual(listedPositions({ positions: [A] }), [A]);
  assert.deepEqual(listedPositions(null), []);
});

test("alerter: announces a manual position once, only after the grace period", () => {
  const alerter = createManualAlerter({ graceMs: 1000 });
  assert.deepEqual(alerter.observe([B], 0), []);
  assert.deepEqual(alerter.observe([B], 999), []);
  assert.deepEqual(alerter.observe([B], 1000), [B]);
  assert.deepEqual(alerter.observe([B], 5000), []);
});

test("alerter: a position that disappears before the grace ends is never announced", () => {
  const alerter = createManualAlerter({ graceMs: 1000 });
  alerter.observe([B], 0);
  alerter.observe([], 500); // e.g. the bot recorded its own deploy
  assert.deepEqual(alerter.observe([B], 1200), []); // grace restarts from 1200
  assert.deepEqual(alerter.observe([B], 2200), [B]);
});

test("alerter: an announced position is not announced again after a flicker", () => {
  const alerter = createManualAlerter({ graceMs: 1000 });
  alerter.observe([B], 0);
  assert.deepEqual(alerter.observe([B], 1000), [B]);
  alerter.observe([], 2000);
  assert.deepEqual(alerter.observe([B], 4000), []);
});

test("guard: automatic runs cannot close or claim a manual position", () => {
  const trackedSet = new Set(["AAAA1111"]);
  for (const toolName of ["close_position", "claim_fees"]) {
    const reason = manualGuardReason({ interactive: false, toolName, args: { position_address: "BBBB2222" }, trackedSet });
    assert.match(reason, /manual position/, toolName);
  }
});

test("guard: allows the bot's own positions, other tools, operator chat and unreadable state", () => {
  const trackedSet = new Set(["AAAA1111"]);
  const manualArgs = { position_address: "BBBB2222" };
  assert.equal(manualGuardReason({ interactive: false, toolName: "close_position", args: { position_address: "AAAA1111" }, trackedSet }), null);
  assert.equal(manualGuardReason({ interactive: false, toolName: "get_position_pnl", args: manualArgs, trackedSet }), null);
  // Telegram chat runs as MANAGER when the text mentions "close", but it is the operator asking.
  assert.equal(manualGuardReason({ interactive: true, toolName: "close_position", args: manualArgs, trackedSet }), null);
  assert.equal(manualGuardReason({ interactive: false, toolName: "close_position", args: manualArgs, trackedSet: null }), null);
  assert.equal(manualGuardReason({ interactive: false, toolName: "close_position", args: {}, trackedSet }), null);
});

test("guard: automatic runs cannot swap a token that isn't the bot's", () => {
  const isBotToken = (mint) => mint === "BOTMINT1";
  const reason = manualGuardReason({ interactive: false, toolName: "swap_token", args: { input_mint: "USERMINT", output_mint: "SOL" }, trackedSet: new Set(), isBotToken });
  assert.match(reason, /swap_token blocked/);
  // Unknown ownership is treated as the operator's.
  assert.match(manualGuardReason({ interactive: false, toolName: "swap_token", args: { input_mint: "USERMINT" }, trackedSet: null }), /swap_token blocked/);
});

test("guard: automatic runs may swap SOL, USDC and the bot's own tokens; the operator may swap anything", () => {
  const isBotToken = (mint) => mint === "BOTMINT1";
  const auto = (input_mint) => manualGuardReason({ interactive: false, toolName: "swap_token", args: { input_mint }, trackedSet: new Set(), isBotToken });
  for (const mint of ["SOL", "native", "So11111111111111111111111111111111111111112", "USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "BOTMINT1"]) {
    assert.equal(auto(mint), null, mint);
  }
  assert.equal(manualGuardReason({ interactive: true, toolName: "swap_token", args: { input_mint: "USERMINT" }, trackedSet: new Set(), isBotToken }), null);
});
