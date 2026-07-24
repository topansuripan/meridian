/**
 * wallet-reconcile.js — keep the wallet in SOL after closes.
 *
 * Two guarantees:
 *  1. `shouldRunPostCloseSweep` — decide whether a close_position result should
 *     trigger the auto-swap-back pipeline. Critically, this returns true even
 *     when the close reports failure *only* because the position-record recheck
 *     timed out while the close txs already confirmed on-chain (relay/RPC lag).
 *     Gating the sweep behind strict success was the bug that stranded base
 *     tokens in the wallet.
 *  2. `reconcileWalletToSol` — safety-net sweep that swaps any stray, non
 *     SOL/USDC token sitting in the wallet above the dust threshold back to SOL.
 *     Backstop for every orphan path (close-verification lag, relay-zap
 *     fallback, late-arriving tokens, process restarts).
 *
 * All I/O in `reconcileWalletToSol` is injected so it is unit-testable without
 * a wallet or network.
 */

const DEFAULT_SOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function shouldRunPostCloseSweep(result) {
  if (!result || result.blocked) return false;

  const succeeded = result.success !== false && !result.error;
  if (succeeded) return true;

  // Soft failure: the close txs confirmed on-chain, only the position-list
  // recheck lagged. The base token is already in the wallet — sweep it.
  const txsLanded =
    (Array.isArray(result.close_txs) && result.close_txs.length > 0) ||
    (Array.isArray(result.txs) && result.txs.length > 0);
  return Boolean(result.verification_timeout && txsLanded && result.base_mint);
}

export async function reconcileWalletToSol({
  getWalletBalances,
  getOpenPositions,
  autoSwapToSol,
  addPendingSwap,
  log = () => {},
  minUsd = 0.1,
  solMint = DEFAULT_SOL_MINT,
  usdcMint = DEFAULT_USDC_MINT,
} = {}) {
  const balances = await getWalletBalances();
  const tokens = Array.isArray(balances?.tokens) ? balances.tokens : [];

  const protectedMints = new Set([
    solMint,
    usdcMint,
    "SOL",
    "USDC",
    // Helius returns native SOL balance with this non-canonical mint
    // (44 × '1', no trailing '2'). Without it, every reconcile cycle tries
    // to swap the wallet's own SOL back to SOL.
    "So11111111111111111111111111111111111111111",
  ]);
  try {
    const positions = (await getOpenPositions?.()) || [];
    for (const p of positions) {
      if (p?.base_mint) protectedMints.add(p.base_mint);
    }
  } catch {
    // If positions can't be fetched, fall back to protecting only SOL/USDC.
  }

  const strays = tokens.filter((t) => {
    if (!t?.mint || protectedMints.has(t.mint)) return false;
    const usd = Number(t.usd);
    return Number.isFinite(usd) && usd >= minUsd;
  });

  let swept = 0;
  let queued = 0;
  for (const t of strays) {
    const symbol = t.symbol || String(t.mint).slice(0, 8);
    log("reconcile", `Stray ${symbol} ($${Number(t.usd).toFixed(2)}) in wallet — swapping back to SOL`);
    const res = await autoSwapToSol(t.mint, { minUsd });
    if (res?.success || res?.skipped) {
      swept++;
    } else {
      addPendingSwap({
        mint: t.mint,
        symbol,
        source: "reconcile",
        reason: res?.error || "reconcile swap failed",
      });
      queued++;
    }
  }

  return { strays: strays.length, swept, queued };
}
