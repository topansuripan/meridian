/**
 * usdc-parking.js — keep idle funds in USDC between positions.
 *
 *  - `parkExcessSol` runs after a close and swaps SOL above the gas reserve into USDC.
 *  - `fundSolForDeploy` runs before a deploy and swaps just enough USDC back to SOL
 *    to cover the deploy amount, the reserve and the new position's rent.
 *
 * All I/O is injected so both are unit-testable without a wallet or network
 * (same pattern as wallet-reconcile.js).
 */

// A new DLMM position locks ~0.042–0.044 SOL of rent (refunded on close) plus tx fees.
// Funding only deploy + reserve would let that rent eat the gas reserve.
export const DEPLOY_RENT_SOL = 0.05;

const USDC_DECIMALS = 6;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialize async critical sections. The executor holds one lock across
 * top-up + deploy and across each park, so a park can't sell SOL a deploy just
 * funded and two deploys can't count the same SOL.
 */
export function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => fn());
    tail = run.catch(() => {});
    return run;
  };
}

export async function parkExcessSol({
  getWalletBalances,
  swapToken,
  reserveFor,
  usdcMint,
  minUsd = 1,
  attempts = 4,
  delayMs = 3000,
  sleep = wait,
}) {
  let reserveSol = 0;
  let solPrice = 0;
  let excessSol = 0;
  let excessUsd = 0;

  // The swap-back after a close can show up in the balance a few seconds late.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const balances = await getWalletBalances();
    solPrice = Number(balances.sol_price || 0);
    reserveSol = reserveFor(balances);
    excessSol = Number((balances.sol || 0) - reserveSol);
    excessUsd = solPrice > 0 ? excessSol * solPrice : 0;

    if (Number.isFinite(excessSol) && excessSol > 0 && Number.isFinite(excessUsd) && excessUsd >= minUsd) {
      break;
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }

  if (!Number.isFinite(excessSol) || excessSol <= 0) {
    return { skipped: true, reason: "no excess SOL to park", reserveSol, excessSol, excessUsd };
  }
  if (!Number.isFinite(excessUsd) || excessUsd < minUsd) {
    return { skipped: true, reason: `excess SOL below $${minUsd}`, reserveSol, excessSol, excessUsd };
  }

  // Floor, not round: rounding up would dip into the reserve.
  const amountToSwap = Math.floor(excessSol * 1e4) / 1e4;
  if (amountToSwap <= 0) {
    return { skipped: true, reason: "amount rounds to zero", reserveSol };
  }

  const swapResult = await swapToken({
    input_mint: "SOL",
    output_mint: usdcMint,
    amount: amountToSwap,
  });

  // swapToken reports amount_out in raw base units.
  const rawOut = Number(swapResult?.amount_out);
  return {
    ...swapResult,
    success: swapResult?.success !== false && !swapResult?.error,
    amount: amountToSwap,
    usdcOut: Number.isFinite(rawOut) ? rawOut / 10 ** USDC_DECIMALS : null,
    reserveSol,
    reserveUsd: solPrice > 0 ? reserveSol * solPrice : null,
  };
}

export async function fundSolForDeploy(amountSol, {
  getWalletBalances,
  swapToken,
  reserveFor,
  usdcMint,
  settleMs = 3000,
  settleChecks = 4,
  sleep = wait,
}) {
  const amount = Number(amountSol);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: `Invalid deploy amount for SOL funding: ${amountSol}` };
  }

  const before = await getWalletBalances();
  const sol = Number(before.sol || 0);
  const usdc = Number(before.usdc || 0);
  const reserveSol = reserveFor(before);
  // The deploy itself needs `minRequired`; the rent buffer keeps the reserve intact.
  const minRequired = amount + reserveSol;
  const target = minRequired + DEPLOY_RENT_SOL;
  if (sol >= target) {
    return { success: true, skipped: true, reason: "enough SOL already available", reserveSol, minRequired };
  }

  const solPrice = Number(before.sol_price || 0);
  if (!(solPrice > 0)) {
    return { success: false, error: "Cannot estimate SOL price to fund deploy from USDC" };
  }
  if (sol + usdc / solPrice < minRequired) {
    return {
      success: false,
      error: `Insufficient liquid balance: need ${minRequired.toFixed(4)} SOL for deploy + reserve, have ${sol.toFixed(4)} SOL + ${usdc.toFixed(2)} USDC`,
    };
  }

  // Full top-up when USDC allows; otherwise whatever USDC there is (covers the floor, not all the buffer).
  const neededUsdc = (target - sol) * solPrice * 1.03;
  const amountUsdc = Math.min(Number(neededUsdc.toFixed(2)), Math.floor(usdc * 100) / 100);
  if (amountUsdc < 1) {
    if (sol >= minRequired) {
      return { success: true, skipped: true, reason: "enough SOL for deploy + reserve", reserveSol, minRequired };
    }
    return { success: false, error: `USDC top-up too small to fund deploy (${amountUsdc.toFixed(2)} USDC)` };
  }

  const swapResult = await swapToken({
    input_mint: usdcMint,
    output_mint: "SOL",
    amount: amountUsdc,
  });
  if (swapResult?.success === false || swapResult?.error) {
    return { success: false, error: swapResult?.error || "USDC → SOL top-up failed" };
  }

  // The balance can lag the confirmed swap by a few seconds.
  let finalSol = sol;
  for (let check = 0; check < settleChecks; check++) {
    await sleep(settleMs);
    finalSol = Number((await getWalletBalances()).sol || 0);
    if (finalSol >= minRequired) break;
  }
  const funded = finalSol >= minRequired;
  return {
    success: funded,
    tx: swapResult.tx,
    amountUsdc,
    reserveSol,
    minRequired,
    finalSol,
    error: funded ? null : `Top-up completed but SOL still below required amount (${finalSol.toFixed(4)} < ${minRequired.toFixed(4)})`,
  };
}
