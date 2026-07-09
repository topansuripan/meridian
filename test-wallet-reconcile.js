/**
 * Tests for wallet-reconcile.js — guaranteeing closed-position base tokens are
 * swapped back to SOL even when close verification lags, plus the safety-net
 * sweep of stray wallet tokens.
 * Run: node --test test-wallet-reconcile.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRunPostCloseSweep, reconcileWalletToSol } from "./wallet-reconcile.js";
import { normalizeMint, swapToken } from "./tools/wallet.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_A = "A1111111111111111111111111111111111111111111";
const MINT_B = "B2222222222222222222222222222222222222222222";

// ── shouldRunPostCloseSweep ────────────────────────────────────────────────

test("runs the sweep for a fully successful close", () => {
  assert.equal(
    shouldRunPostCloseSweep({ success: true, base_mint: MINT_A, close_txs: ["sig"] }),
    true,
  );
});

test("does NOT run for a blocked close (spectate/safety)", () => {
  assert.equal(shouldRunPostCloseSweep({ blocked: true, reason: "spectate" }), false);
});

test("does NOT run for a genuine close failure", () => {
  assert.equal(
    shouldRunPostCloseSweep({ success: false, error: "relay order returned no transactions" }),
    false,
  );
});

test("RUNS when close txs confirmed on-chain but the position-record recheck timed out", () => {
  // This is the exact traindog bug: txs landed, base token is in the wallet,
  // only getMyPositions() lagged — the sweep MUST still fire.
  assert.equal(
    shouldRunPostCloseSweep({
      success: false,
      verification_timeout: true,
      error: "Close transactions sent but position still appears open after verification window",
      close_txs: ["closeSig"],
      base_mint: MINT_A,
    }),
    true,
  );
});

test("does NOT run on verification timeout when base_mint is unknown", () => {
  assert.equal(
    shouldRunPostCloseSweep({
      success: false,
      verification_timeout: true,
      close_txs: ["closeSig"],
    }),
    false,
  );
});

test("does NOT run on verification timeout when no txs landed", () => {
  assert.equal(
    shouldRunPostCloseSweep({
      success: false,
      verification_timeout: true,
      base_mint: MINT_A,
      close_txs: [],
    }),
    false,
  );
});

// ── normalizeMint / swapToken same-mint guard (stuck swap-back loop) ────────

// A real SPL token mint (44 chars, valid length range) that happens to start
// with "So1" but is NOT wSOL. The old greedy normalizeMint coerced exactly this.
const SO1_LOOKALIKE = "So1eFakeTokenMintNotWrappedSo1234567aBCDEFGh";

test("normalizeMint coerces explicit SOL aliases to wSOL", () => {
  assert.equal(normalizeMint("SOL"), SOL_MINT);
  assert.equal(normalizeMint("native"), SOL_MINT);
  assert.equal(normalizeMint(SOL_MINT), SOL_MINT);
});

test("normalizeMint does NOT coerce a 'So1'-prefixed non-wSOL token to wSOL", () => {
  // Regression: the old greedy startsWith('So1') / /^So1+$/ logic turned this
  // real token into wSOL, collapsing inputMint === outputMint on swap-back.
  assert.equal(normalizeMint(SO1_LOOKALIKE), SO1_LOOKALIKE);
  assert.notEqual(normalizeMint(SO1_LOOKALIKE), SOL_MINT);
  // The lookalike and real SOL must stay distinct so a swap-back is a real swap.
  assert.notEqual(normalizeMint(SO1_LOOKALIKE), normalizeMint(SOL_MINT));
});

test("swapToken short-circuits when input and output normalize to the same mint", async () => {
  const res = await swapToken({ input_mint: SOL_MINT, output_mint: "SOL", amount: 0.5 });
  assert.equal(res.skipped, true);
  assert.equal(res.success, true);
  assert.equal(res.input_mint, SOL_MINT);
  assert.equal(res.output_mint, SOL_MINT);
});

// ── reconcileWalletToSol ───────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  const swapped = [];
  const queued = [];
  return {
    swapped,
    queued,
    deps: {
      getWalletBalances: async () => ({
        tokens: [
          { mint: SOL_MINT, symbol: "SOL", usd: 500 },
          { mint: USDC_MINT, symbol: "USDC", usd: 42 },
          { mint: MINT_A, symbol: "FOO", usd: 12.5 },   // stray, above dust
          { mint: MINT_B, symbol: "BAR", usd: 0.002 },  // dust, below threshold
        ],
      }),
      getOpenPositions: async () => [],
      autoSwapToSol: async (mint) => {
        swapped.push(mint);
        return { success: true, symbol: "FOO", tx: "swapSig" };
      },
      addPendingSwap: (entry) => {
        queued.push(entry);
        return entry;
      },
      minUsd: 0.1,
      ...overrides,
    },
  };
}

test("sweeps a stray non-SOL/USDC token above the dust threshold", async () => {
  const { swapped, queued, deps } = makeDeps();
  const res = await reconcileWalletToSol(deps);
  assert.deepEqual(swapped, [MINT_A]);
  assert.equal(queued.length, 0);
  assert.equal(res.strays, 1);
  assert.equal(res.swept, 1);
});

test("never sweeps SOL, USDC, or sub-dust tokens", async () => {
  const { swapped, deps } = makeDeps();
  await reconcileWalletToSol(deps);
  assert.ok(!swapped.includes(SOL_MINT));
  assert.ok(!swapped.includes(USDC_MINT));
  assert.ok(!swapped.includes(MINT_B)); // dust
});

test("protects the base token of an open position from being swept", async () => {
  const { swapped, deps } = makeDeps({
    getOpenPositions: async () => [{ base_mint: MINT_A }],
  });
  const res = await reconcileWalletToSol(deps);
  assert.deepEqual(swapped, []);
  assert.equal(res.strays, 0);
});

test("queues a stray token for retry when its swap fails", async () => {
  const { queued, deps } = makeDeps({
    autoSwapToSol: async () => ({ success: false, error: "no route" }),
  });
  const res = await reconcileWalletToSol(deps);
  assert.equal(res.queued, 1);
  assert.equal(queued[0].mint, MINT_A);
  assert.equal(queued[0].source, "reconcile");
});
