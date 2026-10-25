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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  return {
    ...swapResult,
    success: swapResult?.success !== false && !swapResult?.error,
    amount: amountToSwap,
    reserveSol,
    reserveUsd: solPrice > 0 ? reserveSol * solPrice : null,
  };
}

export async function fundSolForDeploy(amountSol, {
  getWalletBalances,
  swapToken,
  reserveFor,
  usdcMint,
  settleMs = 4000,
  sleep = wait,
}) {
  const before = await getWalletBalances();
  const sol = Number(before.sol || 0);
  const reserveSol = reserveFor(before);
  // The deploy itself only needs `minRequired`; the rent buffer keeps the reserve intact.
  const minRequired = amountSol + reserveSol;
  const target = minRequired + DEPLOY_RENT_SOL;
  if (sol >= target) {
    return { success: true, skipped: true, reason: "enough SOL already available", reserveSol, minRequired };
  }

  const solPrice = Number(before.sol_price || 0);
  if (!(solPrice > 0)) {
    return { success: false, error: "Cannot estimate SOL price to fund deploy from USDC" };
  }

  const deficitSol = target - sol;
  const neededUsdc = deficitSol * solPrice * 1.03;
  if ((before.usdc || 0) < neededUsdc) {
    if (sol >= minRequired) {
      return { success: true, skipped: true, reason: "enough SOL for deploy + reserve (no USDC for rent buffer)", reserveSol, minRequired };
    }
    return {
      success: false,
      error: `Insufficient liquid balance: need about ${neededUsdc.toFixed(2)} USDC to top up ${deficitSol.toFixed(4)} SOL, have ${Number(before.usdc || 0).toFixed(2)} USDC`,
    };
  }

  const amountUsdc = Math.max(0.1, Number(neededUsdc.toFixed(2)));
  const swapResult = await swapToken({
    input_mint: usdcMint,
    output_mint: "SOL",
    amount: amountUsdc,
  });
  if (swapResult?.success === false || swapResult?.error) {
    return { success: false, error: swapResult?.error || "USDC → SOL top-up failed" };
  }

  await sleep(settleMs);
  const after = await getWalletBalances();
  const finalSol = Number(after.sol || 0);
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
