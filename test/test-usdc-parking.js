import { test } from "node:test";
import assert from "node:assert/strict";
import { parkExcessSol, fundSolForDeploy, createMutex, parkingSwitchChanges, DEPLOY_RENT_SOL } from "../usdc-parking.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function fakes({ balances, swapResult = { success: true, tx: "sig1", amount_out: 192 } }) {
  const queue = Array.isArray(balances) ? [...balances] : [balances];
  const swaps = [];
  return {
    swaps,
    deps: {
      getWalletBalances: async () => (queue.length > 1 ? queue.shift() : queue[0]),
      swapToken: async (args) => {
        swaps.push(args);
        return swapResult;
      },
      reserveFor: () => 0.08,
      usdcMint: USDC,
      sleep: async () => {},
    },
  };
}

test("park: swaps SOL above the reserve to USDC and reports the reserve", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 2, usdc: 0, sol_price: 100 } });
  const r = await parkExcessSol(deps);
  assert.deepEqual(swaps, [{ input_mint: "SOL", output_mint: USDC, amount: 1.92 }]);
  assert.equal(r.success, true);
  assert.equal(r.amount, 1.92);
  assert.equal(r.reserveSol, 0.08);
  assert.equal(r.reserveUsd, 8);
  assert.equal(r.tx, "sig1");
});

test("park: floors the amount so the reserve is never dipped into", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 1.23456789, usdc: 0, sol_price: 100 } });
  await parkExcessSol(deps);
  assert.equal(swaps[0].amount, 1.1545);
});

test("park: waits for a late swap-back before deciding there is nothing to park", async () => {
  const { deps, swaps } = fakes({
    balances: [
      { sol: 0.085, usdc: 0, sol_price: 100 },
      { sol: 1.08, usdc: 0, sol_price: 100 },
    ],
  });
  const r = await parkExcessSol(deps);
  assert.equal(r.success, true);
  assert.equal(swaps[0].amount, 1);
});

test("park: skips an excess under $1", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 0.085, usdc: 0, sol_price: 100 } });
  const r = await parkExcessSol(deps);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /below \$1/);
  assert.equal(swaps.length, 0);
});

test("park: skips when SOL is at or under the reserve", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 0.05, usdc: 300, sol_price: 100 } });
  const r = await parkExcessSol(deps);
  assert.equal(r.skipped, true);
  assert.equal(swaps.length, 0);
});

test("park: a failed swap is reported as not successful", async () => {
  const { deps } = fakes({
    balances: { sol: 2, usdc: 0, sol_price: 100 },
    swapResult: { success: false, error: "route not found" },
  });
  const r = await parkExcessSol(deps);
  assert.equal(r.success, false);
  assert.equal(r.error, "route not found");
});

test("fund: skips when SOL already covers deploy + reserve + rent", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 1 + 0.08 + DEPLOY_RENT_SOL, usdc: 0, sol_price: 100 } });
  const r = await fundSolForDeploy(1, deps);
  assert.equal(r.success, true);
  assert.equal(r.skipped, true);
  assert.equal(swaps.length, 0);
});

test("fund: swaps only the shortfall (with rent buffer) plus 3% from USDC", async () => {
  const { deps, swaps } = fakes({
    balances: [
      { sol: 0.08, usdc: 500, sol_price: 100 },
      { sol: 1.16, usdc: 390, sol_price: 100 },
    ],
  });
  const r = await fundSolForDeploy(1, deps);
  // target 1 + 0.08 + 0.05 = 1.13 SOL; deficit 1.05 SOL × $100 × 1.03 = 108.15 USDC
  assert.deepEqual(swaps, [{ input_mint: USDC, output_mint: "SOL", amount: 108.15 }]);
  assert.equal(r.success, true);
  assert.equal(r.tx, "sig1");
  assert.equal(r.amountUsdc, 108.15);
});

test("fund: falls back to the old floor when USDC can't cover the rent buffer", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 1.09, usdc: 0, sol_price: 100 } });
  const r = await fundSolForDeploy(1, deps);
  assert.equal(r.success, true);
  assert.equal(r.skipped, true);
  assert.equal(swaps.length, 0);
});

test("fund: blocks without swapping when USDC is short and SOL is under deploy + reserve", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 0.5, usdc: 20, sol_price: 100 } });
  const r = await fundSolForDeploy(1, deps);
  assert.equal(r.success, false);
  assert.match(r.error, /Insufficient liquid balance/);
  assert.equal(swaps.length, 0);
});

test("fund: fails when the swap lands but SOL is still under deploy + reserve", async () => {
  const { deps } = fakes({
    balances: [
      { sol: 0.08, usdc: 500, sol_price: 100 },
      { sol: 0.5, usdc: 390, sol_price: 100 },
    ],
  });
  const r = await fundSolForDeploy(1, deps);
  assert.equal(r.success, false);
  assert.match(r.error, /still below/);
});

test("fund: fails without a SOL price", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 0.08, usdc: 500, sol_price: 0 } });
  const r = await fundSolForDeploy(1, deps);
  assert.equal(r.success, false);
  assert.equal(swaps.length, 0);
});

test("park: reports USDC received in UI units (swap returns raw base units)", async () => {
  const { deps } = fakes({
    balances: { sol: 2, usdc: 0, sol_price: 100 },
    swapResult: { success: true, tx: "sig1", amount_out: "191800000" },
  });
  const r = await parkExcessSol(deps);
  assert.equal(r.usdcOut, 191.8);
});

test("fund: a string amount is treated as a number, not concatenated", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 5, usdc: 0, sol_price: 100 } });
  const r = await fundSolForDeploy("0.5", deps);
  assert.equal(r.success, true);
  assert.equal(r.skipped, true);
  assert.equal(swaps.length, 0);
});

test("fund: rejects a missing or non-positive amount without swapping", async () => {
  for (const bad of [undefined, 0, -1, "abc"]) {
    const { deps, swaps } = fakes({ balances: { sol: 0.08, usdc: 500, sol_price: 100 } });
    const r = await fundSolForDeploy(bad, deps);
    assert.equal(r.success, false, `amount ${bad}`);
    assert.equal(swaps.length, 0);
  }
});

test("fund: tops up with all the USDC there is when it covers deploy + reserve but not the buffer", async () => {
  const { deps, swaps } = fakes({
    balances: [
      { sol: 0.08, usdc: 62, sol_price: 100 },
      { sol: 0.7, usdc: 0, sol_price: 100 },
    ],
  });
  // floor 0.6 + 0.08 = 0.68 SOL; full target would need 66.95 USDC; only 62 available.
  const r = await fundSolForDeploy(0.6, deps);
  // one cent under the reported balance, which the balance API rounds to the cent
  assert.deepEqual(swaps, [{ input_mint: USDC, output_mint: "SOL", amount: 61.99 }]);
  assert.equal(r.success, true);
});

test("fund: blocks without swapping when SOL + USDC can't cover deploy + reserve", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 0.08, usdc: 50, sol_price: 100 } });
  const r = await fundSolForDeploy(0.6, deps);
  assert.equal(r.success, false);
  assert.match(r.error, /Insufficient liquid balance/);
  assert.equal(swaps.length, 0);
});

test("fund: keeps polling while the balance lags behind a landed swap", async () => {
  const { deps } = fakes({
    balances: [
      { sol: 0.08, usdc: 500, sol_price: 100 },
      { sol: 0.08, usdc: 500, sol_price: 100 },
      { sol: 0.08, usdc: 500, sol_price: 100 },
      { sol: 1.16, usdc: 391, sol_price: 100 },
    ],
  });
  const r = await fundSolForDeploy(1, deps);
  assert.equal(r.success, true);
  assert.equal(r.finalSol, 1.16);
});

test("createMutex runs critical sections one at a time, even when one throws", async () => {
  const lock = createMutex();
  const events = [];
  const slow = (name, ms, fail = false) => lock(async () => {
    events.push(`${name}:start`);
    await new Promise((res) => setTimeout(res, ms));
    events.push(`${name}:end`);
    if (fail) throw new Error(name);
    return name;
  });
  const results = await Promise.allSettled([slow("a", 20, true), slow("b", 1), slow("c", 1)]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].value, "b");
});

test("/park on turns on both parking and deploy funding", () => {
  assert.deepEqual(parkingSwitchChanges(true), { autoParkUsdcAfterClose: true, autoFundSolFromUsdc: true });
});

test("/park off stops parking but keeps funding so leftover USDC still pays for deploys", () => {
  assert.deepEqual(parkingSwitchChanges(false), { autoParkUsdcAfterClose: false });
});

test("fund: blocks when USDC covers deploy + reserve only before swap costs", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 0.08, usdc: 60.2, sol_price: 100 } });
  // 0.08 + 0.602 = 0.682 ≥ 0.68 at a straight conversion, but not after ~1% swap costs
  const r = await fundSolForDeploy(0.6, deps);
  assert.equal(r.success, false);
  assert.equal(swaps.length, 0);
});

test("fund: the floor always leaves room for position rent, even when the reserve is smaller", async () => {
  const { deps, swaps } = fakes({ balances: { sol: 1.04, usdc: 0, sol_price: 250 } });
  deps.reserveFor = () => 0.032; // $8 at $250/SOL — below the ~0.044 SOL position rent
  const r = await fundSolForDeploy(1, deps);
  assert.equal(r.success, false, "1.04 SOL clears 1 + 0.032 reserve but not 1 + 0.05 rent");
  assert.equal(swaps.length, 0);
});

test("createMutex reports busy while a section runs", async () => {
  const lock = createMutex();
  assert.equal(lock.busy, false);
  let release;
  const held = lock(() => new Promise((res) => { release = res; }));
  await Promise.resolve();
  assert.equal(lock.busy, true);
  release();
  await held;
  assert.equal(lock.busy, false);
});
