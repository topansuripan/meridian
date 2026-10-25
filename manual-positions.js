/**
 * manual-positions.js — the operator trades by hand from the bot's wallet.
 *
 * A position is the bot's when state.json has a record for it (every deploy path
 * calls trackPosition); anything else in the wallet is manual and left alone.
 * getMyPositions splits its result with `splitPositions`; automatic consumers read
 * `positions` (bot only), and callers that must see everything use `listedPositions`.
 *
 * Pure — no I/O — so it unit-tests without a wallet (same pattern as wallet-reconcile.js).
 */

// The reconcile sweep only sells tokens from pools the bot was in this recently.
export const BOT_TOKEN_WINDOW_MS = 24 * 60 * 60 * 1000;

// A new bot deploy can show up in the wallet a few seconds before it is recorded.
export const MANUAL_ALERT_GRACE_MS = 3 * 60 * 1000;

const GUARDED_TOOLS = new Set(["close_position", "claim_fees"]);

/**
 * `trackedSet` null means state.json couldn't be read: keep every position as the
 * bot's (the behaviour before manual positions existed) rather than drop its stop losses.
 */
export function splitPositions(positions, trackedSet) {
  const list = Array.isArray(positions) ? positions : [];
  if (!trackedSet) return { bot: list, manual: [] };
  const bot = [];
  const manual = [];
  for (const p of list) (trackedSet.has(p?.position) ? bot : manual).push(p);
  return { bot, manual };
}

export function listedPositions(result) {
  return [...(result?.positions || []), ...(result?.manual_positions || [])];
}

export function createManualAlerter({ graceMs = MANUAL_ALERT_GRACE_MS } = {}) {
  const firstSeen = new Map();
  const announced = new Set();
  return {
    /** Returns the manual positions to announce now. */
    observe(manualPositions, now = Date.now()) {
      const present = new Set();
      const due = [];
      for (const p of manualPositions || []) {
        if (!p?.position) continue;
        present.add(p.position);
        if (!firstSeen.has(p.position)) firstSeen.set(p.position, now);
        if (!announced.has(p.position) && now - firstSeen.get(p.position) >= graceMs) {
          announced.add(p.position);
          due.push(p);
        }
      }
      for (const address of [...firstSeen.keys()]) {
        if (!present.has(address)) firstSeen.delete(address);
      }
      return due;
    },
  };
}

/**
 * Block reason when an automatic run tries to close or claim a manual position; null
 * when the call may proceed. Keyed on `interactive` (operator chat / REPL), not the
 * role: Telegram chat runs as MANAGER whenever the text mentions "close".
 */
export function manualGuardReason({ interactive, toolName, args, trackedSet }) {
  if (interactive || !GUARDED_TOOLS.has(toolName) || !trackedSet) return null;
  const address = args?.position_address;
  if (!address || trackedSet.has(address)) return null;
  return `${toolName} blocked: ${address.slice(0, 8)}… is a manual position (opened outside the bot). Only the operator manages it.`;
}
