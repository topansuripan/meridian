# SOL-Crash Circuit Breaker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect a market-wide SOL/USD crash and, on a normal-position stop-loss, close all normal positions to USDC and pause normal deploys for 6h with stabilization-gated re-entry.

**Architecture:** A new self-contained module `sol-crash-guard.js` holds the price buffer, the dump-detection math, and the trip/cooldown/re-entry state machine. It imports nothing from `executor.js`/`dlmm.js`/`wallet.js` — the management cron in `index.js` injects the close/swap/positions/balance functions (dependency injection). `executor.js` and `index.js` import only the pure read `isCoolingDown()` to gate deploys/screening. This avoids circular imports and keeps the core logic unit-testable with mocked dependencies and an injectable clock.

**Tech Stack:** Node ≥18 ESM, `node:test` + `node:assert/strict` for tests (run with `node --test`), `node-cron` (existing), Jupiter swap via existing `swapToken`, CoinGecko for startup backfill.

**Design doc:** `docs/plans/2026-06-28-sol-crash-circuit-breaker-design.md`

---

## Conventions for this plan

- Tests live in `test/` and run with `node --test test/<file>.js`. There is no jest/vitest — use `node:test`.
- All time-dependent functions take an explicit `now` (epoch ms) argument so tests are deterministic. Production callers pass `Date.now()`.
- The core functions operate on an explicit `state` object passed in. Module-level singleton wrappers (`recordSolPrice`, `isCoolingDown`, `tick`) manage the persisted singleton.
- Commit after every green step. Use `git add -f` only for files under `docs/` (that dir is gitignored but design/plan docs are tracked there by repo convention). `sol-crash-state.json` must be added to `.gitignore` (runtime state, like `state.json`).

---

### Task 1: Add `config.solCrashGuard` section

**Files:**
- Modify: `config.js` (add a new section inside the `export const config = {…}` literal, after the `risk` block, ~line 90+)
- Modify: `.gitignore` (ignore `sol-crash-state.json`)
- Test: `test/test-sol-crash-guard.js`

**Step 1: Write the failing test**

Create `test/test-sol-crash-guard.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.solCrashGuard has sane defaults", () => {
  const c = config.solCrashGuard;
  assert.ok(c, "solCrashGuard section exists");
  assert.equal(c.enabled, true);
  assert.equal(c.drop1hPct, 3);
  assert.equal(c.drawdown6hPct, 5);
  assert.equal(c.cooldownHours, 6);
  assert.equal(c.reentryRequiresStable, true);
  assert.equal(c.scope, "normal");
  assert.equal(typeof c.keepGasReserveSol, "number");
  assert.equal(c.backfillOnStart, true);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/test-sol-crash-guard.js`
Expected: FAIL — `solCrashGuard section exists` (config.solCrashGuard is undefined).

**Step 3: Implement**

In `config.js`, inside `export const config = {`, after the `risk: { … },` block, add:

```js
  // ─── SOL-Crash Circuit Breaker ───────────
  solCrashGuard: {
    enabled:               u.solCrashGuard?.enabled              ?? true,
    drop1hPct:             u.solCrashGuard?.drop1hPct            ?? 3,
    drawdown6hPct:         u.solCrashGuard?.drawdown6hPct        ?? 5,
    cooldownHours:         u.solCrashGuard?.cooldownHours        ?? 6,
    reentryRequiresStable: u.solCrashGuard?.reentryRequiresStable ?? true,
    scope:                 u.solCrashGuard?.scope                ?? "normal",
    keepGasReserveSol:     u.solCrashGuard?.keepGasReserveSol    ?? (u.gasReserve ?? 0.2),
    backfillOnStart:       u.solCrashGuard?.backfillOnStart      ?? true,
  },
```

In `.gitignore`, under the "Runtime state" block (next to `state.json`), add:

```
sol-crash-state.json
```

**Step 4: Run test to verify it passes**

Run: `node --test test/test-sol-crash-guard.js`
Expected: PASS (1 test).

**Step 5: Commit**

```bash
git add config.js .gitignore test/test-sol-crash-guard.js
git commit -m "feat(sol-guard): add solCrashGuard config section"
```

---

### Task 2: Pure dump-detection math (`computeSolMetrics`, `isDumping`)

**Files:**
- Create: `sol-crash-guard.js`
- Test: `test/test-sol-crash-guard.js` (append)

**Step 1: Write the failing tests**

Append to `test/test-sol-crash-guard.js`:

```js
import { computeSolMetrics, isDumping } from "../sol-crash-guard.js";

const HOUR = 3600_000;
// helper: build hourly [ms, price] history ending at `end`, oldest first
function hist(prices, end) {
  return prices.map((p, i) => [end - (prices.length - 1 - i) * HOUR, p]);
}
const CFG = { drop1hPct: 3, drawdown6hPct: 5 };

test("computeSolMetrics: flat market is not dumping", () => {
  const end = 10_000_000_000_000;
  const h = hist([67, 67, 67, 67, 67, 67, 67], end);
  const m = computeSolMetrics(h, end);
  assert.equal(m.hasEnoughHistory, true);
  assert.ok(Math.abs(m.drop1h) < 0.01);
  assert.ok(Math.abs(m.drawdown6h) < 0.01);
  assert.equal(isDumping(m, CFG).dumping, false);
});

test("computeSolMetrics: sharp 1h drop trips drop1h", () => {
  const end = 10_000_000_000_000;
  const h = hist([68, 68, 68, 68, 68, 68, 64.9], end); // -4.56% last hour
  const m = computeSolMetrics(h, end);
  assert.ok(m.drop1h <= -3, `drop1h=${m.drop1h}`);
  const d = isDumping(m, CFG);
  assert.equal(d.dumping, true);
  assert.match(d.reason, /1h/);
});

test("computeSolMetrics: slow 6h bleed trips drawdown6h", () => {
  const end = 10_000_000_000_000;
  // high 69.3 six hours ago, grinding down to 65.5 now (~-5.5% off high), no single -3% hour
  const h = hist([69.3, 68.6, 67.9, 67.2, 66.5, 65.9, 65.5], end);
  const m = computeSolMetrics(h, end);
  assert.ok(m.drop1h > -3, `drop1h=${m.drop1h} should not trip 1h`);
  assert.ok(m.drawdown6h <= -5, `drawdown6h=${m.drawdown6h}`);
  assert.equal(isDumping(m, CFG).dumping, true);
});

test("computeSolMetrics: insufficient history never dumps", () => {
  const end = 10_000_000_000_000;
  const h = [[end - 10 * 60_000, 70], [end, 64]]; // only 10 min of data
  const m = computeSolMetrics(h, end);
  assert.equal(m.hasEnoughHistory, false);
  assert.equal(isDumping(m, CFG).dumping, false);
});
```

**Step 2: Run to verify it fails**

Run: `node --test test/test-sol-crash-guard.js`
Expected: FAIL — cannot find `computeSolMetrics`/`isDumping` export.

**Step 3: Implement**

Create `sol-crash-guard.js`:

```js
/**
 * SOL-Crash Circuit Breaker.
 *
 * Detects a market-wide SOL/USD crash and, on a normal-position stop-loss,
 * closes all normal positions to USDC and pauses normal deploys for a cooldown,
 * re-entering only once SOL has stabilized. Pure detection math + a trip/cooldown
 * state machine; the management cron injects close/swap/positions/balance fns.
 *
 * See docs/plans/2026-06-28-sol-crash-circuit-breaker-design.md
 */

const HOUR = 3600_000;
const MIN_HISTORY_MS = 55 * 60_000; // need ~1h before the 1h test is valid

/** Price at the sample closest to (now - HOUR), or null if none old enough. */
function priceAround(priceHistory, targetMs) {
  let best = null, bestDist = Infinity;
  for (const [ms, price] of priceHistory) {
    const dist = Math.abs(ms - targetMs);
    if (dist < bestDist) { bestDist = dist; best = price; }
  }
  return best;
}

/**
 * @param {Array<[number, number]>} priceHistory  oldest-first [ms, price]
 * @param {number} now  epoch ms
 * @returns {{ drop1h:number, drawdown6h:number, hasEnoughHistory:boolean, priceNow:number|null }}
 *          drop1h / drawdown6h are signed percentages (negative = falling)
 */
export function computeSolMetrics(priceHistory, now = Date.now()) {
  const pts = (priceHistory || []).filter(p => Array.isArray(p) && Number.isFinite(p[1]));
  if (pts.length < 2) {
    return { drop1h: 0, drawdown6h: 0, hasEnoughHistory: false, priceNow: pts[0]?.[1] ?? null };
  }
  const priceNow = pts[pts.length - 1][1];
  const oldest = pts[0][0];
  const hasEnoughHistory = (now - oldest) >= MIN_HISTORY_MS;

  const price1hAgo = priceAround(pts, now - HOUR);
  const drop1h = price1hAgo ? (priceNow / price1hAgo - 1) * 100 : 0;

  const window6h = pts.filter(([ms]) => ms >= now - 6 * HOUR);
  const high6h = Math.max(priceNow, ...window6h.map(p => p[1]));
  const drawdown6h = high6h > 0 ? (priceNow / high6h - 1) * 100 : 0;

  return { drop1h, drawdown6h, hasEnoughHistory, priceNow };
}

/**
 * @param {object} metrics  from computeSolMetrics
 * @param {{drop1hPct:number, drawdown6hPct:number}} cfg
 * @returns {{ dumping:boolean, reason:string|null }}
 */
export function isDumping(metrics, cfg) {
  if (!metrics.hasEnoughHistory) return { dumping: false, reason: null };
  if (metrics.drop1h <= -Math.abs(cfg.drop1hPct)) {
    return { dumping: true, reason: `SOL ${metrics.drop1h.toFixed(1)}% in 1h` };
  }
  if (metrics.drawdown6h <= -Math.abs(cfg.drawdown6hPct)) {
    return { dumping: true, reason: `SOL ${metrics.drawdown6h.toFixed(1)}% off 6h high` };
  }
  return { dumping: false, reason: null };
}
```

**Step 4: Run to verify it passes**

Run: `node --test test/test-sol-crash-guard.js`
Expected: PASS (5 tests).

**Step 5: Commit**

```bash
git add sol-crash-guard.js test/test-sol-crash-guard.js
git commit -m "feat(sol-guard): pure SOL dump-detection math"
```

---

### Task 3: Price buffer (`pushPrice`)

**Files:**
- Modify: `sol-crash-guard.js`
- Test: `test/test-sol-crash-guard.js` (append)

**Step 1: Write the failing test**

```js
import { pushPrice } from "../sol-crash-guard.js";

test("pushPrice appends, sorts, and trims to maxAge", () => {
  const now = 10_000_000_000_000;
  const maxAge = 7 * 3600_000;
  let h = [];
  h = pushPrice(h, 67, now - 8 * 3600_000, maxAge); // older than maxAge -> trimmed on next push
  h = pushPrice(h, 66, now - 1 * 3600_000, maxAge);
  h = pushPrice(h, 65, now, maxAge);
  assert.equal(h.length, 2, "stale 8h-old sample dropped");
  assert.deepEqual(h.map(p => p[1]), [66, 65]);
  // ignores non-finite price
  const before = h.length;
  h = pushPrice(h, NaN, now + 1000, maxAge);
  assert.equal(h.length, before);
});
```

**Step 2: Run to verify it fails**

Run: `node --test test/test-sol-crash-guard.js`
Expected: FAIL — cannot find `pushPrice`.

**Step 3: Implement** — append to `sol-crash-guard.js`:

```js
const DEFAULT_MAX_AGE_MS = 7 * HOUR;

/** Append a sample, drop anything older than maxAgeMs, keep oldest-first. Pure. */
export function pushPrice(priceHistory, price, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!Number.isFinite(price) || price <= 0) return priceHistory;
  const next = [...priceHistory, [now, price]]
    .filter(([ms]) => ms >= now - maxAgeMs)
    .sort((a, b) => a[0] - b[0]);
  return next;
}
```

**Step 4: Run to verify it passes** — Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add sol-crash-guard.js test/test-sol-crash-guard.js
git commit -m "feat(sol-guard): rolling SOL price buffer"
```

---

### Task 4: State persistence + defaults

**Files:**
- Modify: `sol-crash-guard.js`
- Test: `test/test-sol-crash-guard.js` (append)

**Step 1: Write the failing test**

```js
import { defaultState, loadState, saveState } from "../sol-crash-guard.js";
import fs from "node:fs";

test("defaultState shape", () => {
  const s = defaultState();
  assert.deepEqual(s.priceHistory, []);
  assert.equal(s.breaker.active, false);
  assert.equal(s.breaker.cooldownUntil, null);
});

test("saveState/loadState round-trip with explicit path", () => {
  const p = "./test/.tmp-sol-state.json";
  const s = defaultState();
  s.breaker.active = true;
  s.breaker.reason = "test";
  saveState(s, p);
  const loaded = loadState(p);
  assert.equal(loaded.breaker.active, true);
  assert.equal(loaded.breaker.reason, "test");
  fs.unlinkSync(p);
});

test("loadState returns defaults when file missing", () => {
  const loaded = loadState("./test/.does-not-exist.json");
  assert.equal(loaded.breaker.active, false);
});
```

**Step 2: Run to verify it fails** — Expected: FAIL (missing exports).

**Step 3: Implement** — append to `sol-crash-guard.js`:

```js
import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE = "./sol-crash-state.json";

export function defaultState() {
  return {
    priceHistory: [],
    breaker: {
      active: false,
      trippedAt: null,
      cooldownUntil: null,
      reason: null,
      solAtTrip: null,
      closedPositions: [],
      usdcParked: null,
    },
  };
}

export function loadState(path = STATE_FILE) {
  try {
    if (!fs.existsSync(path)) return defaultState();
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    const d = defaultState();
    return { priceHistory: raw.priceHistory ?? [], breaker: { ...d.breaker, ...(raw.breaker ?? {}) } };
  } catch (e) {
    log("sol_guard_warn", `loadState failed: ${e.message}`);
    return defaultState();
  }
}

export function saveState(state, path = STATE_FILE) {
  try {
    fs.writeFileSync(path, JSON.stringify(state, null, 2));
  } catch (e) {
    log("sol_guard_warn", `saveState failed: ${e.message}`);
  }
}
```

> Note: `import fs` / `import { log }` go at the TOP of the file with the other imports; shown here for locality. Move them up when implementing.

**Step 4: Run to verify it passes** — Expected: PASS (9 tests).

**Step 5: Commit**

```bash
git add sol-crash-guard.js test/test-sol-crash-guard.js
git commit -m "feat(sol-guard): state persistence + defaults"
```

---

### Task 5: Trip state machine (`maybeTrip`)

**Files:**
- Modify: `sol-crash-guard.js`
- Test: `test/test-sol-crash-guard.js` (append)

`maybeTrip(state, { now, cfg, deps })` mutates and returns `state`. `deps`:
- `getNormalOpenPositions()` → `Promise<Array<{position, pool_name}>>` (degen already filtered out)
- `closePosition({position_address, reason})` → `Promise<any>`
- `swapSolToUsdc()` → `Promise<{usdcOut:number}>` (closer's freed SOL → USDC, gas reserve kept)
- `notify(text)` → `Promise<void>`

Rules: no-op if `!cfg.enabled`, if already `active`, or if not dumping. When dumping: close each normal position (continue past individual failures), swap to USDC, set breaker fields.

**Step 1: Write the failing test**

```js
import { maybeTrip } from "../sol-crash-guard.js";

function mkDeps(overrides = {}) {
  const closed = [];
  return {
    closed,
    getNormalOpenPositions: async () => [
      { position: "P1", pool_name: "AAA-SOL" },
      { position: "P2", pool_name: "BBB-SOL" },
    ],
    closePosition: async ({ position_address }) => { closed.push(position_address); return { ok: true }; },
    swapSolToUsdc: async () => ({ usdcOut: 150 }),
    notify: async () => {},
    ...overrides,
  };
}
const CFG_FULL = { enabled: true, drop1hPct: 3, drawdown6hPct: 5, cooldownHours: 6, scope: "normal" };

test("maybeTrip closes normal positions and parks USDC when dumping", async () => {
  const now = 10_000_000_000_000;
  const s = defaultState();
  s.priceHistory = hist([68, 68, 68, 68, 68, 68, 64.9], now); // -4.56% 1h
  const deps = mkDeps();
  await maybeTrip(s, { now, cfg: CFG_FULL, deps });
  assert.equal(s.breaker.active, true);
  assert.deepEqual(deps.closed.sort(), ["P1", "P2"]);
  assert.equal(s.breaker.usdcParked, 150);
  assert.equal(s.breaker.cooldownUntil, now + 6 * 3600_000);
  assert.match(s.breaker.reason, /1h/);
});

test("maybeTrip is a no-op on a flat market", async () => {
  const now = 10_000_000_000_000;
  const s = defaultState();
  s.priceHistory = hist([67, 67, 67, 67, 67, 67, 67], now);
  const deps = mkDeps();
  await maybeTrip(s, { now, cfg: CFG_FULL, deps });
  assert.equal(s.breaker.active, false);
  assert.equal(deps.closed.length, 0);
});

test("maybeTrip is a no-op when already active", async () => {
  const now = 10_000_000_000_000;
  const s = defaultState();
  s.breaker.active = true;
  s.priceHistory = hist([68, 68, 68, 68, 68, 68, 64.9], now);
  const deps = mkDeps();
  await maybeTrip(s, { now, cfg: CFG_FULL, deps });
  assert.equal(deps.closed.length, 0, "must not double-close");
});

test("maybeTrip continues past a single close failure", async () => {
  const now = 10_000_000_000_000;
  const s = defaultState();
  s.priceHistory = hist([68, 68, 68, 68, 68, 68, 64.9], now);
  const deps = mkDeps({
    closePosition: async ({ position_address }) => {
      if (position_address === "P1") throw new Error("tx failed");
      return { ok: true };
    },
  });
  await maybeTrip(s, { now, cfg: CFG_FULL, deps });
  assert.equal(s.breaker.active, true, "still trips");
  assert.ok(s.breaker.closedPositions.includes("P2"));
});
```

**Step 2: Run to verify it fails** — Expected: FAIL (missing `maybeTrip`).

**Step 3: Implement** — append to `sol-crash-guard.js`:

```js
export async function maybeTrip(state, { now = Date.now(), cfg, deps }) {
  if (!cfg.enabled || state.breaker.active) return state;
  const metrics = computeSolMetrics(state.priceHistory, now);
  const { dumping, reason } = isDumping(metrics, cfg);
  if (!dumping) return state;

  log("sol_guard", `TRIP: ${reason}. Closing normal positions.`);
  const positions = await deps.getNormalOpenPositions().catch(() => []);
  const closed = [];
  for (const p of positions) {
    try {
      await deps.closePosition({ position_address: p.position, reason: `SOL-crash breaker: ${reason}` });
      closed.push(p.position);
    } catch (e) {
      log("sol_guard_warn", `close failed for ${p.pool_name || p.position}: ${e.message}`);
    }
  }

  let usdcParked = null;
  try {
    const r = await deps.swapSolToUsdc();
    usdcParked = r?.usdcOut ?? null;
  } catch (e) {
    log("sol_guard_warn", `SOL->USDC swap failed: ${e.message} (positions are out of LP; will retry)`);
  }

  state.breaker = {
    active: true,
    trippedAt: now,
    cooldownUntil: now + cfg.cooldownHours * HOUR,
    reason,
    solAtTrip: metrics.priceNow,
    closedPositions: closed,
    usdcParked,
  };

  await deps.notify(
    `🛑 SOL-crash breaker TRIPPED — ${reason}. ` +
    `Closed ${closed.length}/${positions.length} normal positions` +
    (usdcParked != null ? `, parked $${usdcParked.toFixed(2)} USDC` : "") +
    `. Cooldown ${cfg.cooldownHours}h.`
  ).catch(() => {});

  return state;
}
```

**Step 4: Run to verify it passes** — Expected: PASS (13 tests).

**Step 5: Commit**

```bash
git add sol-crash-guard.js test/test-sol-crash-guard.js
git commit -m "feat(sol-guard): trip state machine (close normal -> USDC)"
```

---

### Task 6: Re-entry state machine (`tryReenter`, `isCoolingDownState`)

**Files:**
- Modify: `sol-crash-guard.js`
- Test: `test/test-sol-crash-guard.js` (append)

`tryReenter(state, { now, cfg, deps })`: only acts when `active`. Before `cooldownUntil` → no-op. After: if `reentryRequiresStable` and still dumping → stay parked; else swap USDC→SOL, clear breaker, notify. `deps.swapUsdcToSol()` → `Promise<{solOut:number}>`.

**Step 1: Write the failing test**

```js
import { tryReenter, isCoolingDownState } from "../sol-crash-guard.js";

function activeState(now, history) {
  const s = defaultState();
  s.priceHistory = history;
  s.breaker = { active: true, trippedAt: now - 6 * 3600_000, cooldownUntil: now, reason: "SOL -5% off 6h high",
    solAtTrip: 65, closedPositions: ["P1"], usdcParked: 150 };
  return s;
}
const CFG_RE = { enabled: true, drop1hPct: 3, drawdown6hPct: 5, cooldownHours: 6, reentryRequiresStable: true };

test("isCoolingDownState true while active and before cooldownUntil", () => {
  const now = 10_000_000_000_000;
  const s = activeState(now, []);
  s.breaker.cooldownUntil = now + 3600_000;
  assert.equal(isCoolingDownState(s, now), true);
});

test("tryReenter stays parked while still dumping after cooldown", async () => {
  const now = 10_000_000_000_000;
  const s = activeState(now, hist([68, 68, 68, 68, 68, 68, 64.9], now)); // still -4.56%/1h
  let swapped = false;
  await tryReenter(s, { now, cfg: CFG_RE, deps: { swapUsdcToSol: async () => { swapped = true; return { solOut: 2 }; }, notify: async () => {} } });
  assert.equal(s.breaker.active, true);
  assert.equal(swapped, false);
});

test("tryReenter re-enters once SOL stabilized", async () => {
  const now = 10_000_000_000_000;
  const s = activeState(now, hist([66, 66, 66, 66, 66, 66, 66], now)); // flat
  let swapped = false;
  await tryReenter(s, { now, cfg: CFG_RE, deps: { swapUsdcToSol: async () => { swapped = true; return { solOut: 2.3 }; }, notify: async () => {} } });
  assert.equal(swapped, true);
  assert.equal(s.breaker.active, false);
  assert.equal(s.breaker.cooldownUntil, null);
});

test("tryReenter no-op before cooldown elapses", async () => {
  const now = 10_000_000_000_000;
  const s = activeState(now, hist([66, 66, 66, 66, 66, 66, 66], now));
  s.breaker.cooldownUntil = now + 3600_000; // 1h left
  let swapped = false;
  await tryReenter(s, { now, cfg: CFG_RE, deps: { swapUsdcToSol: async () => { swapped = true; return { solOut: 2 }; }, notify: async () => {} } });
  assert.equal(swapped, false);
  assert.equal(s.breaker.active, true);
});
```

**Step 2: Run to verify it fails** — Expected: FAIL (missing exports).

**Step 3: Implement** — append to `sol-crash-guard.js`:

```js
export function isCoolingDownState(state, now = Date.now()) {
  return !!(state.breaker.active);
}

export async function tryReenter(state, { now = Date.now(), cfg, deps }) {
  if (!state.breaker.active) return state;
  if (now < (state.breaker.cooldownUntil ?? 0)) return state; // cooldown not elapsed

  if (cfg.reentryRequiresStable) {
    const metrics = computeSolMetrics(state.priceHistory, now);
    if (isDumping(metrics, cfg).dumping) {
      log("sol_guard", "Cooldown elapsed but SOL still dumping — staying parked.");
      return state; // re-check next cycle
    }
  }

  let solOut = null;
  try {
    const r = await deps.swapUsdcToSol();
    solOut = r?.solOut ?? null;
  } catch (e) {
    log("sol_guard_warn", `USDC->SOL re-entry swap failed: ${e.message} (staying parked, will retry)`);
    return state; // stay active; retry next cycle
  }

  const priceNow = computeSolMetrics(state.priceHistory, now).priceNow;
  await deps.notify(
    `✅ SOL-crash breaker CLEARED — SOL stabilized` +
    (priceNow ? ` at $${priceNow.toFixed(2)}` : "") +
    (solOut != null ? `. Swapped USDC→${solOut.toFixed(3)} SOL` : "") +
    `. Resuming normal deploys.`
  ).catch(() => {});

  state.breaker = defaultState().breaker; // clear (active=false, cooldownUntil=null)
  return state;
}
```

> `isCoolingDownState` intentionally keys off `active` only — a position stays parked until `tryReenter` clears it (which only happens post-cooldown + stable), so `active` is the single source of truth for "block deploys".

**Step 4: Run to verify it passes** — Expected: PASS (17 tests).

**Step 5: Commit**

```bash
git add sol-crash-guard.js test/test-sol-crash-guard.js
git commit -m "feat(sol-guard): re-entry state machine"
```

---

### Task 7: Singleton wrappers + `tick` + `isCoolingDown` + backfill

**Files:**
- Modify: `sol-crash-guard.js`
- Test: `test/test-sol-crash-guard.js` (append — backfill parsing + tick wiring)

These are the module-level functions `index.js`/`executor.js` actually call. `tick({ now, deps })` is the single per-cycle entry point.

**Step 1: Write the failing tests**

```js
import { parseCoinGeckoPrices } from "../sol-crash-guard.js";

test("parseCoinGeckoPrices maps {prices:[[ms,usd]]} to history", () => {
  const cg = { prices: [[1000, 67.1], [2000, 66.9], [3000, "bad"]] };
  const h = parseCoinGeckoPrices(cg);
  assert.deepEqual(h, [[1000, 67.1], [2000, 66.9]]); // drops non-finite
});
```

**Step 2: Run to verify it fails** — Expected: FAIL (missing `parseCoinGeckoPrices`).

**Step 3: Implement** — append to `sol-crash-guard.js`:

```js
import { config } from "./config.js";

let _state = loadState();

export function recordSolPrice(price, now = Date.now()) {
  _state.priceHistory = pushPrice(_state.priceHistory, price, now);
}

export function isCoolingDown(now = Date.now()) {
  if (!config.solCrashGuard.enabled) return false;
  return isCoolingDownState(_state, now);
}

export function getBreakerStatus() {
  return { ..._state.breaker, samples: _state.priceHistory.length };
}

export function parseCoinGeckoPrices(cg) {
  return (cg?.prices ?? [])
    .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(p => [p[0], p[1]]);
}

/**
 * Best-effort startup backfill of ~24h hourly SOL/USD from CoinGecko.
 * @param {(url:string)=>Promise<Response>} fetchFn  defaults to global fetch
 */
export async function backfillSolHistory(fetchFn = fetch, now = Date.now()) {
  if (!config.solCrashGuard.enabled || !config.solCrashGuard.backfillOnStart) return;
  const oldest = _state.priceHistory[0]?.[0] ?? now;
  if (now - oldest >= 6 * HOUR) return; // already have enough
  try {
    const from = Math.floor((now - 24 * HOUR) / 1000);
    const to = Math.floor(now / 1000);
    const url = `https://api.coingecko.com/api/v3/coins/solana/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const cg = await res.json();
    const fetched = parseCoinGeckoPrices(cg);
    // merge: keep within 7h window, dedupe by ms, sort
    const merged = [..._state.priceHistory, ...fetched]
      .filter(([ms]) => ms >= now - 7 * HOUR)
      .sort((a, b) => a[0] - b[0]);
    _state.priceHistory = merged;
    saveState(_state);
    log("sol_guard", `Backfilled ${fetched.length} SOL price points from CoinGecko.`);
  } catch (e) {
    log("sol_guard_warn", `Backfill failed (will fill organically): ${e.message}`);
  }
}

/**
 * Per-management-cycle entry point. Records the latest SOL price, then either
 * attempts re-entry (if parked) or evaluates a trip. Injected deps wire the
 * actual close/swap/positions/notify implementations from index.js.
 */
let _ticking = false;
export async function tick({ now = Date.now(), solPrice, deps }) {
  if (!config.solCrashGuard.enabled) return;
  if (_ticking) return; // guard against overlapping cycles
  _ticking = true;
  try {
    if (Number.isFinite(solPrice)) recordSolPrice(solPrice, now);
    const cfg = config.solCrashGuard;
    if (_state.breaker.active) {
      await tryReenter(_state, { now, cfg, deps });
    } else {
      await maybeTrip(_state, { now, cfg, deps });
    }
    saveState(_state);
  } finally {
    _ticking = false;
  }
}

// Test-only: reset the singleton between tests.
export function __resetStateForTests(s = defaultState()) { _state = s; }
```

> Move `import { config } from "./config.js";` to the import block at the top.

**Step 4: Run to verify it passes** — Expected: PASS (18 tests).

**Step 5: Commit**

```bash
git add sol-crash-guard.js test/test-sol-crash-guard.js
git commit -m "feat(sol-guard): singleton wrappers, tick, backfill"
```

---

### Task 8: Replay validation against the real June 25 crash

**Files:**
- Modify: `test/test-sol-crash-guard.js` (append)

Proves the breaker trips at the actual Jun 25 crash using real hourly SOL/USD values (WIB hours; values from CoinGecko, Jun 25 2026).

**Step 1: Write the test**

```js
test("REPLAY: Jun 25 SOL crash trips the breaker at the 21:00 WIB drop", async () => {
  // Real hourly SOL/USD (WIB) for Jun 25 2026 from CoinGecko.
  const prices = [66.42,64.90,65.81,65.96,67.67,67.75,67.70,67.89,67.71,67.79,
                  67.58,67.53,68.05,68.96,69.35,69.29,69.00,68.85,68.25,67.98,
                  68.34,65.21,66.34,65.89];
  const start = 10_000_000_000_000;
  const full = prices.map((p, i) => [start + i * 3600_000, p]);

  // Walk hour by hour; the breaker should be flat until the 21:00 candle (index 21).
  const cfg = { enabled: true, drop1hPct: 3, drawdown6hPct: 5, cooldownHours: 6, scope: "normal" };
  let trippedAtIndex = -1;
  for (let i = 6; i < full.length; i++) {
    const s = defaultState();
    s.priceHistory = full.slice(0, i + 1);
    const now = full[i][0];
    const deps = mkDeps();
    await maybeTrip(s, { now, cfg, deps });
    if (s.breaker.active) { trippedAtIndex = i; break; }
  }
  assert.equal(trippedAtIndex, 21, `expected trip at the 21:00 candle (-4.6%), got index ${trippedAtIndex}`);
});
```

**Step 2: Run to verify** — Run: `node --test test/test-sol-crash-guard.js`
Expected: PASS (19 tests). If it trips earlier/later, the thresholds in `isDumping` are wrong — fix the math, not the test.

**Step 3: Commit**

```bash
git add test/test-sol-crash-guard.js
git commit -m "test(sol-guard): replay real Jun 25 crash trips the breaker"
```

---

### Task 9: Wire `tick` + backfill into the management cron (`index.js`)

**Files:**
- Modify: `index.js` — import the guard; call `backfillSolHistory()` at startup; call `tick({...})` near the end of `runManagementCycle()` (defined at `index.js:433`).

**Step 1: Add the import** (near the other tool imports, ~`index.js:10-16`):

```js
import * as solCrashGuard from "./sol-crash-guard.js";
import { getMyPositions, closePosition } from "./tools/dlmm.js"; // if not already imported
```

(Check existing imports first — `getMyPositions` may already be imported; if so, don't duplicate.)

**Step 2: Build the deps object + call `tick` inside `runManagementCycle`**

Find the `finally { _managementBusy = false; … }` block at the end of `runManagementCycle` (`~index.js:655`). Immediately BEFORE that `finally` (i.e., at the end of the `try`), insert:

```js
    // ─── SOL-crash circuit breaker ──────────────────────────────
    try {
      const bal = await getWalletBalances();
      await solCrashGuard.tick({
        solPrice: bal.sol_price,
        deps: {
          getNormalOpenPositions: async () => {
            const live = await getMyPositions({ force: true, silent: true }).catch(() => ({ positions: [] }));
            return (live.positions || []).filter(p => getTrackedPosition(p.position)?.degen !== true);
          },
          closePosition: ({ position_address, reason }) =>
            executeTool("close_position", { position_address, reason }, "MANAGER"),
          swapSolToUsdc: async () => {
            const b = await getWalletBalances();
            const swappable = Math.max(0, b.sol - config.solCrashGuard.keepGasReserveSol);
            if (swappable <= 0) return { usdcOut: 0 };
            const before = (await getWalletBalances()).usdc;
            await swapToken({ input_mint: "SOL", output_mint: config.tokens.USDC, amount: swappable });
            const after = (await getWalletBalances()).usdc;
            return { usdcOut: Math.max(0, after - before) };
          },
          swapUsdcToSol: async () => {
            const b = await getWalletBalances();
            if (b.usdc <= 1) return { solOut: 0 };
            const before = (await getWalletBalances()).sol;
            await swapToken({ input_mint: config.tokens.USDC, output_mint: "SOL", amount: b.usdc });
            const after = (await getWalletBalances()).sol;
            return { solOut: Math.max(0, after - before) };
          },
          notify: (text) => sendMessage(text),
        },
      });
    } catch (e) {
      log("cron_error", `SOL-crash guard tick failed: ${e.message}`);
    }
```

Confirm `getWalletBalances`, `swapToken`, `executeTool`, `getTrackedPosition`, `sendMessage`, `config`, `log` are all imported in `index.js` (most are; add any missing). `executeTool`'s 3rd arg is the agent role — verify the signature at `executor.js` and pass `"MANAGER"` (or omit if the signature differs).

**Step 3: Backfill at startup** — find where crons start (`startCronJobs`, ~`index.js:1421`) or the main init, and add once during boot:

```js
solCrashGuard.backfillSolHistory().catch(() => {});
```

**Step 4: Syntax check**

Run: `node --check index.js`
Expected: no output (valid).

**Step 5: Commit**

```bash
git add index.js
git commit -m "feat(sol-guard): wire tick + backfill into management cron"
```

---

### Task 10: Gate normal deploys (`executor.js`)

**Files:**
- Modify: `tools/executor.js` — `runSafetyChecks` (`executor.js:999`), within the `deploy_position` branch.

**Step 1: Add the import** (top of `executor.js`):

```js
import { isCoolingDown as solGuardCoolingDown } from "../sol-crash-guard.js";
```

**Step 2: Add the gate** — inside `runSafetyChecks`, in the `deploy_position` block, after `const isDegen = !!args.degen;` (`executor.js:1057`), add:

```js
      // SOL-crash breaker: block NORMAL deploys while parked (degen unaffected)
      if (!isDegen && solGuardCoolingDown()) {
        return { safe: false, reason: "SOL-crash circuit breaker active — normal deploys paused until SOL stabilizes." };
      }
```

(Match the exact failure-return shape used by the surrounding checks — confirm it's `{ safe: false, reason }` by reading a nearby check; adjust if the codebase uses a different shape.)

**Step 3: Syntax check** — Run: `node --check tools/executor.js` → valid.

**Step 4: Commit**

```bash
git add tools/executor.js
git commit -m "feat(sol-guard): block normal deploys while breaker active"
```

---

### Task 11: Pause normal screening (`index.js`)

**Files:**
- Modify: `index.js` — the two screening-gate sites that already check `lossBreaker.triggered` (`~index.js:707` and `~index.js:2140`).

**Step 1: Add the guard to both gates.** At `~index.js:707`:

```js
    if (lossBreaker.triggered || solCrashGuard.isCoolingDown()) {
      const reason = lossBreaker.triggered
        ? formatLossCircuitBreakerReason(lossBreaker)
        : "SOL-crash circuit breaker active — screening paused until SOL stabilizes";
      // … existing pause/return handling …
    }
```

Apply the same `|| solCrashGuard.isCoolingDown()` at `runDeterministicScreen` (`~index.js:2140`), adjusting its return string similarly. Read each site first and adapt the surrounding code exactly — don't blindly paste.

**Step 2: Syntax check** — Run: `node --check index.js` → valid.

**Step 3: Run the full guard test suite** — Run: `node --test test/test-sol-crash-guard.js`
Expected: all PASS (19 tests).

**Step 4: Commit**

```bash
git add index.js
git commit -m "feat(sol-guard): pause normal screening while breaker active"
```

---

### Task 12: DRY_RUN integration smoke + docs

**Files:**
- Modify: `CLAUDE.md` (document the new breaker under a "SOL-Crash Circuit Breaker" heading near the other safety checks)
- Modify: `user-config.example.json` (add a commented/example `solCrashGuard` block if the repo documents config there)

**Step 1: DRY_RUN smoke test**

Run: `DRY_RUN=true node -e "import('./sol-crash-guard.js').then(async g => { g.__resetStateForTests(); const now=Date.now(); const h=[]; for(let i=6;i>=0;i--) g.recordSolPrice(i===0?64.9:68, now-i*3600_000); await g.tick({ now, solPrice:64.9, deps:{ getNormalOpenPositions:async()=>[{position:'X',pool_name:'T-SOL'}], closePosition:async()=>({}), swapSolToUsdc:async()=>({usdcOut:100}), swapUsdcToSol:async()=>({solOut:1}), notify:async(t)=>console.log('NOTIFY:',t) } }); console.log('cooling:', g.isCoolingDown(now)); })"`
Expected: prints `NOTIFY: 🛑 SOL-crash breaker TRIPPED …` and `cooling: true`. Clean up any `sol-crash-state.json` it writes (it's gitignored).

**Step 2: Update CLAUDE.md** — add a concise section describing: trigger (normal stop-loss / per-cycle), thresholds (3%/1h or 5%/6h), action (close normal → USDC), cooldown (6h, stabilization-gated re-entry), scope (normal only), config keys, and `sol-crash-state.json`.

**Step 3: Full syntax check** — Run: `npm test` (runs `node --check` across all `.js`). Expected: exits 0.

**Step 4: Commit**

```bash
git add CLAUDE.md user-config.example.json
git commit -m "docs(sol-guard): document SOL-crash circuit breaker"
```

---

### Task 13: Deploy to VPS

**Files:** none (operational)

Per CLAUDE.md deploy workflow. Do NOT run automatically — confirm with the operator first, since this is a live trading agent.

```bash
git push origin feature/degen-mode
ssh root@43.133.133.150 "cd ~/meridian && git pull origin feature/degen-mode && npm install && pm2 restart meridian"
ssh root@43.133.133.150 "pm2 logs meridian --lines 30 --nostream"
```

Verify in logs: `Backfilled N SOL price points from CoinGecko.` on boot. Optionally add `solCrashGuard` overrides to the VPS `user-config.json` (not in git).

---

## Validation checklist (run before deploy)

- [ ] `node --test test/test-sol-crash-guard.js` → 19 passing
- [ ] `npm test` → 0 (syntax across repo)
- [ ] `node --check index.js`, `node --check tools/executor.js`, `node --check config.js` → valid
- [ ] DRY_RUN smoke prints TRIP notify + `cooling: true`
- [ ] `git status` clean except intended files; `sol-crash-state.json` is gitignored
