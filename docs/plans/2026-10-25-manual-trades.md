# Manual Trades in the Bot Wallet — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The bot manages only the positions and tokens it opened, so the operator can trade by hand from the same wallet.

**Architecture:** `getMyPositions` splits its result by ownership, using `state.json` records. Bot positions stay in `positions`, and everything else moves to `manual_positions`. Automatic consumers keep reading `positions`, and the few callers that need everything use `listedPositions()`. A pure module, `manual-positions.js`, holds the split, the alerter and the agent guard. The reconcile sweep gets an `isBotToken` filter backed by pool-memory.

**Tech Stack:** Node ESM, `node:test`, no new dependencies. Design: `docs/plans/2026-10-25-manual-trades-design.md`.

Tests are gitignored (`test-*.js`), so commit them with `git add -f`. Never use `git commit -a`. Run tests with `node --test test/<file>.js` and `node --test test-wallet-reconcile.js`.

---

### Task 1: `manual-positions.js` (split, list, alerter, guard)

**Files:**
- Create: `manual-positions.js`
- Test: `test/test-manual-positions.js`

**Step 1: Write the failing tests**

```js
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

test("guard: automatic roles cannot close or claim a manual position", () => {
  const trackedSet = new Set(["AAAA1111"]);
  for (const agentType of ["MANAGER", "SCREENER"]) {
    for (const toolName of ["close_position", "claim_fees"]) {
      const reason = manualGuardReason({ agentType, toolName, args: { position_address: "BBBB2222" }, trackedSet });
      assert.match(reason, /manual position/, `${agentType} ${toolName}`);
    }
  }
});

test("guard: allows the bot's own positions, other tools, operator chat and unreadable state", () => {
  const trackedSet = new Set(["AAAA1111"]);
  const manualArgs = { position_address: "BBBB2222" };
  assert.equal(manualGuardReason({ agentType: "MANAGER", toolName: "close_position", args: { position_address: "AAAA1111" }, trackedSet }), null);
  assert.equal(manualGuardReason({ agentType: "MANAGER", toolName: "get_position_pnl", args: manualArgs, trackedSet }), null);
  assert.equal(manualGuardReason({ agentType: "GENERAL", toolName: "close_position", args: manualArgs, trackedSet }), null);
  assert.equal(manualGuardReason({ agentType: "MANAGER", toolName: "close_position", args: manualArgs, trackedSet: null }), null);
  assert.equal(manualGuardReason({ agentType: "MANAGER", toolName: "close_position", args: {}, trackedSet }), null);
});
```

**Step 2:** Run `node --test test/test-manual-positions.js`. Expected: FAIL (module not found).

**Step 3: Implement `manual-positions.js`**

```js
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
 * Block reason when an automatic role (anything but the operator's GENERAL chat)
 * tries to close or claim a manual position; null when the call may proceed.
 */
export function manualGuardReason({ agentType, toolName, args, trackedSet }) {
  if (agentType === "GENERAL" || !GUARDED_TOOLS.has(toolName) || !trackedSet) return null;
  const address = args?.position_address;
  if (!address || trackedSet.has(address)) return null;
  return `${toolName} blocked: ${address.slice(0, 8)}… is a manual position (opened outside the bot). Only the operator manages it.`;
}
```

**Step 4:** Run `node --test test/test-manual-positions.js`. Expected: 8 pass.

**Step 5: Commit**

```bash
git add manual-positions.js && git add -f test/test-manual-positions.js
git commit -m "feat(manual): ownership split, alerter and agent guard for manual positions"
```

---

### Task 2: `state.js` `getTrackedPositionSet()`

**Files:** Modify `state.js` (after `getTrackedPosition`, ~line 323).

```js
let _trackedSetCache = null; // { mtimeMs, size, set }

/**
 * Addresses of every position the bot has recorded, open or closed. Returns an empty
 * set when there's no state.json yet, and null when it can't be read; callers then treat
 * every position as the bot's. Cached on the file's mtime/size: getMyPositions calls this
 * on every PnL tick and state.json is large.
 */
export function getTrackedPositionSet() {
  let stat;
  try {
    stat = fs.statSync(STATE_FILE);
  } catch {
    return new Set();
  }
  if (_trackedSetCache && _trackedSetCache.mtimeMs === stat.mtimeMs && _trackedSetCache.size === stat.size) {
    return _trackedSetCache.set;
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const set = new Set(Object.keys(state.positions || {}));
    _trackedSetCache = { mtimeMs: stat.mtimeMs, size: stat.size, set };
    return set;
  } catch (err) {
    log("state_error", `Failed to read state.json for position ownership: ${err.message}`);
    return null;
  }
}
```

Verify: `timeout 60 node --input-type=module -e 'import { getTrackedPositionSet } from "./state.js"; const s = getTrackedPositionSet(); console.log(s && s.size); console.log(getTrackedPositionSet() === s); process.exit(0)'`. Expected: a number, then `true`. Commit: `feat(state): getTrackedPositionSet for position ownership`.

---

### Task 3: Split in `getMyPositions` and switch the see-everything callers in dlmm.js

**Files:** Modify `tools/dlmm.js`.

1. Import `{ splitPositions, listedPositions } from "../manual-positions.js"` and `getTrackedPositionSet` from `../state.js`, which is already imported in that statement.
2. Add above `getMyPositions`:
   ```js
   // Bot-recorded positions stay in `positions`; anything opened outside the bot goes to
   // `manual_positions`, so every automatic consumer ignores it (manual-positions.js).
   function splitByOwnership(result) {
     const { bot, manual } = splitPositions(result.positions, getTrackedPositionSet());
     return { ...result, positions: bot, total_positions: bot.length, manual_positions: manual };
   }
   ```
3. RPC path: keep `syncOpenPositions(rpcResult.positions.map(...))` on all addresses, then `const split = splitByOwnership(rpcResult)`. Cache and return `split` for the local wallet. For a `wallet_address` override, return `rpcResult` unsplit.
4. Meteora path: same. `syncOpenPositions` gets all addresses, then the local wallet caches and returns the split result.
5. Replace `X?.positions?.find(...)` / `.some(...)` with `listedPositions(X).find(...)` / `.some(...)` at:
   - the relay deploy match (both `find`s, ~line 689);
   - `getPositionPnl` (~972);
   - the claim snapshot (~1497);
   - the relay close snapshot (~1601) and its verification loop (~1681);
   - the local close snapshot (~1884) and its verification loop (~1985);
   - the `_positionsCache` fallback (~2092).

Verify with `node --check tools/dlmm.js` and `grep -n "\.positions?\.\(find\|some\)" tools/dlmm.js`. Expected: no remaining by-address lookups outside `getMyPositions`. Commit: `feat(positions): split manual positions out of getMyPositions`.

---

### Task 4: Executor, screening, cli and the reconcile filter

**Files:**
- Modify: `wallet-reconcile.js`, `tools/executor.js`, `tools/screening.js`, `cli.js`
- Test: `test-wallet-reconcile.js`

**Step 1: Failing test** (append to `test-wallet-reconcile.js`):

```js
test("with isBotToken, only the bot's own tokens are swept", async () => {
  const { swapped, deps } = makeDeps({ isBotToken: (mint) => mint !== MINT_A });
  const res = await reconcileWalletToSol(deps);
  assert.deepEqual(swapped, []);
  assert.equal(res.strays, 0);
});

test("with isBotToken, a bot token is still swept", async () => {
  const { swapped, deps } = makeDeps({ isBotToken: (mint) => mint === MINT_A });
  await reconcileWalletToSol(deps);
  assert.deepEqual(swapped, [MINT_A]);
});
```

Run `node --test test-wallet-reconcile.js`. Expected: the first new test FAILs.

**Step 2:** In `reconcileWalletToSol`, add the param `isBotToken = null` and the filter line `if (isBotToken && !isBotToken(t.mint)) return false;` after the protected-mint check. Update the header comment. Run the tests: all pass.

**Step 3: Executor:**
- In `reconcileWallet()`, set `getOpenPositions: async () => listedPositions(await getMyPositions({ force: true }))` and `isBotToken: (mint) => wasBaseMintDeployedSince(mint, new Date(Date.now() - BOT_TOKEN_WINDOW_MS))`.
- In the deploy safety check, keep `typeCount` on `positions.positions`, and run `alreadyInPool` and `alreadyHasMint` on `listedPositions(positions)`. Update the reason text to "Already have an open position (yours or the bot's) in pool …".
- Imports: `{ listedPositions, BOT_TOKEN_WINDOW_MS } from "../manual-positions.js"`. `wasBaseMintDeployedSince` is already imported.

**Step 4:** In `screening.js` (~729), set `const positions = listedPositions(await getMyPositions());`, keeping the dynamic import style. In `cli.js` (pnl fallback), set `listedPositions(pos).find(...)`.

**Step 5:** Run `node --check` on each file and the tests. Commit: `feat(manual): duplicate checks and reconcile sweep respect manual trades`.

---

### Task 5: Agent guard

**Files:** Modify `agent.js`. Insert before `await onToolStart?.(...)`, mirroring the once-per-session block:

```js
        // Automatic roles never touch a position the operator opened by hand.
        const manualBlock = manualGuardReason({ interactive, toolName: functionName, args: functionArgs, trackedSet: getTrackedPositionSet() });
        if (manualBlock) {
          log("agent", manualBlock);
          const result = { blocked: true, reason: manualBlock };
          await onToolFinish?.({ name: functionName, args: functionArgs, result, success: false, step });
          return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) };
        }
```

Imports: `manualGuardReason` from `./manual-positions.js` and `getTrackedPositionSet` from `./state.js`. Verify with `node --check agent.js`. (Do NOT run `test/test-agent.js`: it is a live script that runs the real agent and deploys SOL.) Commit: `feat(agent): block automatic close/claim of manual positions`.

---

### Task 6: index.js — Telegram listing, /closeall note, alert

**Files:** Modify `index.js`.

- Import `listedPositions, createManualAlerter` from `./manual-positions.js`. Add a module-level `const manualAlerter = createManualAlerter();`.
- **Management cycle:** right after the `livePositions?.error` early return, add:
  ```js
  for (const p of manualAlerter.observe(livePositions?.manual_positions)) {
    log("cron", `Manual position detected: ${p.pair} ${p.position} — not managing it`);
    sendMessage(`👤 Manual position detected: ${p.pair} (${p.position.slice(0, 8)}…) — the bot won't manage it. If you didn't open it, check the wallet.`).catch(() => {});
  }
  ```
  Confirm that `sendMessage` is imported from telegram.js.
- **`/positions`:** list `listedPositions(result)`. Prefix manual positions with `👤 `. The header reads `📊 Open Positions (N)` plus ` + M manual 👤` when there are manual positions. When there are any, add the footer line `👤 = opened by you; the bot doesn't manage it.`. The empty check runs on the listed length.
- **`/pool <n>`** and **`/close <n>`:** index into `listedPositions(result)`.
- **`/set <n>`:** index into the listed list. If the position is manual, reply "👤 That's your manual position — the bot doesn't manage it, so a note would do nothing." and return.
- **`/closeall`:** stays bot-only. With no bot positions but some manual ones, reply `No bot positions to close (M manual position(s) left open 👤).`. Otherwise append `\n\n👤 M manual position(s) left open.` to the finished message when M > 0.

Verify with `node --check index.js`. Commit: `feat(telegram): show manual positions, alert on new ones, closeall leaves them`.

---

### Task 7: Docs, full tests, review, deploy

- `CLAUDE.md`:
  - add a module row for `manual-positions.js`;
  - add a "## Manual Trades in the Bot Wallet (October 2026)" section covering ownership, what ignores manual positions, `listedPositions` callers, the alert, the reconcile 24 h window, the `null` fallback and tests;
  - update the reconcile and `/closeall` lines.
- Run every unit test file: `for f in $(grep -l "node:test" test/*.js test-*.js); do node --test --test-force-exit $f; done`. Expected: all pass. Only files importing `node:test` are unit tests; `test/test-agent.js` and the screening scripts are live.
- Dispatch a code reviewer subagent on the diff `5ff7ed6..HEAD`, then fix confirmed findings.
- Deploy:
  1. `git push origin feature/degen-mode` (origin only);
  2. VPS: `git merge --ff-only` in a quiet window;
  3. `pm2 restart meridian --update-env`;
  4. check the boot log, and that `node cli.js positions` shows `manual_positions`.

**Execution note:** Task 5 changed during implementation. Telegram chat runs as MANAGER whenever the text mentions "close", so the guard keys on `interactive` rather than `agentType`. The Task 1 tests were updated to match.
