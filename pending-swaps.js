/**
 * Pending-swap registry — stored in pending-swaps.json.
 *
 * Tracks tokens that should have been swapped back to SOL but weren't
 * (failed, unconfirmed, or partial swaps after close/claim). Entries are
 * retried every management cycle via processPendingSwaps() in
 * tools/executor.js until the wallet is verifiably clear of the token.
 */

import fs from "fs";
import { log } from "./logger.js";

const FILE = "./pending-swaps.json";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function load() {
  if (!fs.existsSync(FILE)) return { pending: {}, lastUpdated: null };
  try {
    const state = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!state.pending || typeof state.pending !== "object") state.pending = {};
    return state;
  } catch (err) {
    log("pending_swap_error", `Failed to read pending-swaps.json: ${err.message}`);
    return { pending: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("pending_swap_error", `Failed to write pending-swaps.json: ${err.message}`);
  }
}

/**
 * Queue a token for swap-back retry. Idempotent per mint — re-adding an
 * existing mint keeps its attempt history and first-seen timestamp.
 */
export function addPendingSwap({ mint, symbol = null, source = "close", reason = null }) {
  if (!mint || mint === "SOL" || mint === SOL_MINT || mint === USDC_MINT) return null;
  const state = load();
  const existing = state.pending[mint];
  state.pending[mint] = {
    mint,
    symbol: symbol || existing?.symbol || String(mint).slice(0, 8),
    source: existing?.source || source,
    reason: reason || existing?.reason || null,
    attempts: existing?.attempts || 0,
    lastError: existing?.lastError || null,
    lastAttempt: existing?.lastAttempt || null,
    firstSeen: existing?.firstSeen || new Date().toISOString(),
  };
  save(state);
  log(
    "pending_swap",
    `Queued ${state.pending[mint].symbol} (${String(mint).slice(0, 8)}…) for swap-back retry — ${reason || source}`,
  );
  return state.pending[mint];
}

/** Record a retry attempt (success removes the entry instead — see removePendingSwap). */
export function recordSwapAttempt(mint, { error = null } = {}) {
  const state = load();
  const entry = state.pending[mint];
  if (!entry) return null;
  entry.attempts = (entry.attempts || 0) + 1;
  entry.lastAttempt = new Date().toISOString();
  entry.lastError = error || null;
  save(state);
  return entry;
}

export function removePendingSwap(mint, reason = "done") {
  const state = load();
  const entry = state.pending[mint];
  if (!entry) return false;
  delete state.pending[mint];
  save(state);
  log("pending_swap", `Cleared pending swap for ${entry.symbol} (${String(mint).slice(0, 8)}…) — ${reason}`);
  return true;
}

export function getPendingSwaps() {
  return Object.values(load().pending);
}
