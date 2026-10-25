# Manual Trades in the Bot Wallet — Design

**Goal:** The operator trades by hand from the bot's wallet. The bot manages only what it opened and leaves everything else alone.

## Problem

The bot reads positions and tokens straight from the wallet, so it treats a hand-opened position or a hand-bought token as its own:
- `getDeterministicCloseRule` (stop loss, take profit, pumped above range, out of range) runs on every position from `getMyPositions`, tracked or not.
- The SOL-crash guard, the emergency exit and `/closeall` close every position.
- Hand-opened positions use up `risk.maxPositions`.
- The reconcile sweep sells any token worth over $0.10 that isn't SOL, USDC or an open position's base token, every management cycle.

## What counts as the bot's

A position is the bot's if `state.json` has a record for it. Every deploy path calls `trackPosition`, and the VPS logs show all 1,292 successful deploys came back with a position address. Every other position in the wallet is manual.

A token is the bot's if `wasBaseMintDeployedSince(mint, now - 24h)` holds. That reads `pool-memory.json`, which records `last_deployed_at` at deploy start and again at close.

## Approach

Split at the source. `getMyPositions` returns the bot's positions in `positions` (and `total_positions`) and everything else in `manual_positions`. Every automatic consumer already reads `positions`, so each one ignores manual positions with no change, and future code does too. The few callers that must see everything use `listedPositions(result)`.

The alternative was a `manual` tag filtered at each of the ~10 automatic call sites. It was rejected because one missed filter means the bot acts on the operator's position.

## Components

1. **`manual-positions.js`** (new, pure, dependency-injected):
   - `splitPositions(positions, trackedSet)` returns `{ bot, manual }`. A `null` set (state unreadable) returns everything as bot, which is today's behaviour.
   - `listedPositions(result)` returns bot positions followed by manual ones.
   - `createManualAlerter({ graceMs })` returns `observe(manual, now)`, which yields the manual positions to announce. A position is announced once, only after it has been seen untracked for `graceMs` (3 min), so a bot deploy that hasn't been recorded yet is never announced.
   - `manualGuardReason({ interactive, toolName, args, trackedSet })` returns a block reason when an automatic run calls `close_position` or `claim_fees` on a manual position. It keys on `interactive`, the flag set for operator chat (Telegram and REPL), not on the role: Telegram chat runs as MANAGER whenever the text mentions "close".
2. **`state.js` `getTrackedPositionSet()`** returns the set of tracked addresses, open or closed. It returns an empty set when `state.json` is missing and `null` when the file can't be parsed.
3. **`getMyPositions`** splits the result on both the RPC and the Meteora paths. `syncOpenPositions` still receives every address. A lookup for another wallet (`wallet_address`) is not split.
4. **Callers that see everything** (`listedPositions`):
   - dlmm.js lookups by address: the relay deploy's position match, `getPositionPnl`, the claim and close PnL snapshots, the close-verification loops and the `_positionsCache` fallback.
   - The deploy safety check's duplicate pool and duplicate token checks. The per-type position count stays bot-only.
   - Screening's occupied pools and mints, and the reconcile sweep's protected mints.
   - Telegram `/positions`, `/pool <n>`, `/close <n>` and `/set <n>` all number one list, with bot positions first and manual ones marked 👤. `/set` refuses a manual position because nothing would act on the note.
   - cli `pnl` fallback.
5. **Everything else stays bot-only with no change:**
   - the management cycle, degen management and the PnL poller;
   - the SOL-crash guard and the emergency exit;
   - the screening and opportunity pre-checks and the post-management screening trigger;
   - `/closeall`, which now says how many manual positions it left open;
   - `/status` and the agent's system prompt.
6. **Agent guard** (`agent.js`, before `executeTool`): uses `manualGuardReason`, so the automatic cycles (management, screening, health check) can never close or claim a manual position. The operator's chat (`interactive: true`) still can.
7. **Reconcile sweep:** `reconcileWalletToSol` takes an optional `isBotToken(mint)`. When it's given, only bot tokens are swept. `reconcileWallet` passes the 24-hour pool-memory check. The pending-swap queue only ever holds bot tokens, so it is unchanged.
8. **Alert:** the management cycle runs every 5 min, even with no positions, and feeds `manual_positions` to the alerter. It sends one Telegram message per position: "👤 Manual position detected: PAIR (addr…) — the bot won't manage it. If you didn't open it, check the wallet."

## Behaviour notes

- Closing a manual position through `/close <n>` or chat runs the normal post-close pipeline: the token is swapped back to SOL, and the SOL is parked if parking is on. The close records no performance or lessons because `recordPerformance` only runs for tracked positions.
- SOL and USDC stay shared. Deploys are sized from the wallet balance, and parking works as before.
- A token the bot traded in the last 24 h can still be swept even if the operator also holds it.

## Risks

- **A bot position without a record would be ignored, with no stop loss.** Every deploy records its position, and the alert names any unrecorded position within ~5–10 min.
- **An unreadable `state.json`** makes `getTrackedPositionSet` return `null`. The bot then falls back to managing every position, as it did before this change.

## Testing

`test/test-manual-positions.js` covers:
- the split, including the `null` fallback;
- `listedPositions` ordering;
- the alerter's grace, alert-once and forgetting;
- the guard matrix (interactive × tool × tracked);
- the `isBotToken` filter in `reconcileWalletToSol`.

The existing reconcile tests run unchanged.
