/**
 * Helius wallet-balance resolution with key rotation + on-chain fallback.
 *
 * Why this module exists: `getWalletBalances` used to catch any Helius failure
 * and return `sol: 0`. When the Helius key ran out of credits (429 "max usage
 * reached", 2026-09-15), every cycle read the live wallet as empty and the
 * screening gate logged "insufficient liquid balance (0.000 < 0.100 SOL)" for
 * ~21h while the wallet actually held 7.44 SOL. A failed network call must
 * never be indistinguishable from an empty wallet.
 *
 * Pure / dependency-injected (same pattern as sol-crash-guard.js and
 * wallet-reconcile.js) so it unit-tests without a wallet or network.
 */

const SOL_NATIVE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  // Helius returns native SOL under a non-canonical 44x'1' mint.
  "So11111111111111111111111111111111111111111",
]);

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
}

/** Drop blanks and duplicates, preserving the configured priority order. */
export function normalizeApiKeys(keys) {
  const seen = new Set();
  const out = [];
  for (const raw of keys || []) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function emptyShape(walletAddress) {
  return {
    wallet: walletAddress,
    sol: 0,
    sol_price: 0,
    sol_usd: 0,
    usdc: 0,
    tokens: [],
    total_usd: 0,
  };
}

/**
 * Degraded result: Helius is unavailable, so USD pricing and the SPL token list
 * are unknown — but the SOL balance is read straight from the RPC and is real.
 * `tokens: []` is deliberately empty rather than stale; every consumer treats an
 * empty list conservatively (reconcile sweeps nothing, verifyWalletClearOfToken
 * reports not-clear).
 */
async function degraded({ walletAddress, getSolBalance, error, log }) {
  const base = {
    ...emptyShape(walletAddress),
    // Unknown, NOT zero. sol-crash-guard records any *finite* price, so a 0
    // here would read as a -100% SOL crash and close the entire normal book.
    sol_price: null,
    sol_usd: null,
    degraded: true,
    error,
  };
  try {
    const sol = await getSolBalance();
    base.sol = round(sol, 6);
    log("wallet_warn", `Helius unavailable (${error}) — using on-chain SOL balance ${base.sol}`);
  } catch (rpcError) {
    base.error = `${error}; RPC fallback failed: ${rpcError.message}`;
    log("wallet_error", base.error);
  }
  return base;
}

function shapeHeliusResponse(walletAddress, data) {
  const balances = Array.isArray(data?.balances) ? data.balances : [];

  const solEntry = balances.find((b) => SOL_NATIVE_MINTS.has(b?.mint) || b?.symbol === "SOL");
  const usdcEntry = balances.find((b) => b?.mint === USDC_MINT || b?.symbol === "USDC");

  return {
    wallet: walletAddress,
    sol: round(solEntry?.balance, 6),
    sol_price: round(solEntry?.pricePerToken, 2),
    sol_usd: round(solEntry?.usdValue, 2),
    usdc: round(usdcEntry?.balance, 2),
    tokens: balances.map((b) => ({
      mint: b.mint,
      symbol: b.symbol || String(b.mint || "").slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? round(b.usdValue, 2) : null,
    })),
    total_usd: round(data?.totalUsdValue, 2),
    degraded: false,
  };
}

/**
 * Try each Helius key in order; on total failure read SOL from the RPC.
 *
 * @param {string}   walletAddress
 * @param {string[]} apiKeys        Primary first, fallbacks after.
 * @param {Function} fetchBalances  (url, apiKey) => parsed JSON; throws on non-OK.
 * @param {Function} getSolBalance  () => SOL balance from RPC_URL.
 * @param {Function} [log]
 */
export async function resolveWalletBalances({
  walletAddress,
  apiKeys,
  fetchBalances,
  getSolBalance,
  log = () => {},
}) {
  const keys = normalizeApiKeys(apiKeys);

  if (keys.length === 0) {
    return degraded({
      walletAddress,
      getSolBalance,
      error: "No Helius API key configured (HELIUS_API_KEY)",
      log,
    });
  }

  let lastError = null;
  for (const key of keys) {
    try {
      const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${key}`;
      const data = await fetchBalances(url, key);
      return shapeHeliusResponse(walletAddress, data);
    } catch (error) {
      lastError = error;
      log("wallet_warn", `Helius key failed (${error.message}) — trying next source`);
    }
  }

  return degraded({ walletAddress, getSolBalance, error: lastError.message, log });
}
