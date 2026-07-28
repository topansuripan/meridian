# Fast-Drop Recovery-Exit Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a velocity-based exit for NORMAL positions that detects a sharp drop from a recent high, then exits into a bounce (or at breakeven, or a hard floor) instead of dumping at the bottom.

**Architecture:** A pure, dependency-injected module `fast-drop-guard.js` (mirrors `sol-crash-guard.js` / `wallet-reconcile.js`) exposes one pure function `evaluateFastDropGuard(...)` that owns the state machine. `state.js updatePnlAndCheckExits()` calls it each 30s poll, persisting a per-position sample buffer + watch state in `state.json`, and returns a `FAST_DROP_EXIT` action that flows through the existing 30s-poll close/alert path unchanged.

**Tech Stack:** Node.js ESM, `node:test`, no external deps in the guard module.

**Design doc:** `docs/plans/2026-07-28-fast-drop-recovery-exit-design.md`

---

## Background: key facts for the implementer

- **Value proxy.** Positions are single-sided SOL; `pnl_pct` (from `positionData`) captures IL + price + fees — the position's real economic value. We convert to `factor = 1 + pnl_pct/100` and reason about factor ratios.
- **The 30s poll** (`index.js:1567`) calls `updatePnlAndCheckExits(p.position, p, mgmtCfg)` every 30s. A returned non-null exit `{ action, reason }` triggers a management cycle (which closes) unless `config.spectateMode` (then a "WOULD close" Telegram alert). No extra wiring needed for a new action — returning it is enough.
- **`mgmtCfg`** is `config.management` for normal, `buildDegenMgmtConfig()` for degen. Degen mgmt config only overrides `stopLossPct` / `takeProfitPct` / `outOfRangeWaitMinutes`, so if we gate on `fastDropGuardEnabled` (which degen never sets) the guard is normal-only automatically. We ALSO explicitly guard so it's obvious.
- **Suspicious PnL.** When `pnl_pct_suspicious` is true, all PnL rules are skipped — the guard must skip too (no sampling, no firing).
- **Purity rule.** `Date.now()` / `Math.random()` are fine in `state.js` (runtime), but the guard module must take `now` as a parameter so it's unit-testable and deterministic (see how tests pass explicit timestamps).
- **Test convention.** Tests are plain `node:test` scripts, gitignored but force-added: `git add -f test-*.js`. Run with `node --test test-fast-drop-guard.js`.

---

## Task 1: Create the pure guard module with its state machine

**Files:**
- Create: `fast-drop-guard.js`
- Test: `test-fast-drop-guard.js`

**Step 1: Write the failing tests**

Create `test-fast-drop-guard.js`:

```js
/**
 * Tests for fast-drop-guard.js — velocity-based recovery-exit for NORMAL positions.
 * Detects a sharp drop from a rolling high, then exits into a bounce / at breakeven /
 * at a hard floor rather than dumping at the bottom.
 * Run: node --test test-fast-drop-guard.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFastDropGuard } from "./fast-drop-guard.js";

const MIN = 60_000;
const CFG = {
  fastDropGuardEnabled: true,
  fastDropWindowMinutes: 15,
  fastDropTriggerPct: 15,
  fastDropBouncePct: 10,
  fastDropHardFloorPct: -25,
};
// helper: run a sequence of (minuteOffset, pnl_pct) ticks through the guard,
// threading the returned watch/samples forward. Returns the final result.
function run(seq, cfg = CFG) {
  let watch = null, samples = [];
  let res;
  for (const [min, pnl] of seq) {
    res = evaluateFastDropGuard({ samples, watch, currentPnlPct: pnl, now: min * MIN, cfg });
    watch = res.watch;
    samples = res.samples;
  }
  return res;
}

test("does not arm on a flat/slightly-up book", () => {
  const res = run([[0, 0], [5, 1], [10, 2], [15, 2.5]]);
  assert.equal(res.watch.active, false);
  assert.equal(res.action, null);
});

test("arms watch on a >=15% value drop from rolling high within the window", () => {
  // factor high = 1.05 (at +5%); drop to -12% => factor 0.88; 0.88/1.05-1 = -16.2% <= -15%
  const res = run([[0, 0], [3, 5], [6, -12]]);
  assert.equal(res.watch.active, true);
  assert.equal(res.action, null); // just armed, no exit yet
});

test("does NOT arm on a slow bleed spread beyond the window", () => {
  // high +2% at t=0 then -14% at t=30 — but t=0 sample has expired (window 15m),
  // so the rolling high at t=30 is only the recent samples, not the old +2%.
  const res = run([[0, 2], [20, -6], [30, -14]]);
  assert.equal(res.watch.active, false);
});

test("trails the low downward while watching", () => {
  const res = run([[0, 5], [6, -12], [8, -18]]);
  assert.equal(res.watch.active, true);
  // low factor should reflect the -18% tick (0.82), not the -12% arming tick
  assert.ok(Math.abs(res.watch.lowFactor - 0.82) < 1e-9);
});

test("exits on a >=10% bounce up from the recorded low", () => {
  // arm at -12% (factor .88), fall to -20% (low .80), bounce to -11% (factor .89)
  // .89/.80 - 1 = 11.25% >= 10% => exit
  const res = run([[0, 5], [6, -12], [8, -20], [10, -11]]);
  assert.equal(res.action, "FAST_DROP_EXIT");
  assert.match(res.reason, /bounce/i);
});

test("exits on return to breakeven", () => {
  const res = run([[0, 5], [6, -12], [10, 0]]);
  assert.equal(res.action, "FAST_DROP_EXIT");
  assert.match(res.reason, /breakeven/i);
});

test("force-closes at the hard floor while watching", () => {
  const res = run([[0, 5], [6, -12], [9, -26]]);
  assert.equal(res.action, "FAST_DROP_EXIT");
  assert.match(res.reason, /floor/i);
});

test("no-op when disabled", () => {
  const res = run([[0, 5], [6, -30]], { ...CFG, fastDropGuardEnabled: false });
  assert.equal(res.watch, null);
  assert.equal(res.action, null);
});

test("skips a tick with null pnl (never throws, no sample added)", () => {
  const res = evaluateFastDropGuard({
    samples: [{ ts: 0, factor: 1.05 }], watch: null, currentPnlPct: null, now: 60_000, cfg: CFG,
  });
  assert.equal(res.action, null);
  assert.equal(res.samples.length, 1); // unchanged
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test-fast-drop-guard.js`
Expected: FAIL — `Cannot find module './fast-drop-guard.js'`.

**Step 3: Write the module**

Create `fast-drop-guard.js`:

```js
/**
 * Fast-Drop Recovery-Exit Guard (NORMAL positions).
 *
 * Detects a sharp drop in position value from a rolling high, then exits into a
 * bounce (rise from the low), at breakeven, or at a hard floor — rather than
 * dumping at the bottom. Pure state machine: caller injects `now` and threads
 * the returned { watch, samples } forward. No side effects, no imports.
 *
 * See docs/plans/2026-07-28-fast-drop-recovery-exit-design.md
 */

// value proxy: 1 + pnl_pct/100 (captures IL + price + fees)
const toFactor = (pnlPct) => 1 + pnlPct / 100;

/**
 * @param {object} p
 * @param {Array<{ts:number,factor:number}>} p.samples  prior rolling-window samples
 * @param {null|{active:boolean,lowFactor:number,enteredAt:number}} p.watch  prior watch state
 * @param {number|null} p.currentPnlPct  current PnL % (null/suspicious -> skip)
 * @param {number} p.now  timestamp (ms)
 * @param {object} p.cfg  management config
 * @returns {{watch:null|object, samples:Array, action:null|"FAST_DROP_EXIT", reason:string|null}}
 */
export function evaluateFastDropGuard({ samples = [], watch = null, currentPnlPct, now, cfg }) {
  if (!cfg?.fastDropGuardEnabled) {
    return { watch: null, samples, action: null, reason: null };
  }
  // Skip ticks with no usable pnl — never throw, never fire, leave state untouched.
  if (currentPnlPct == null || !Number.isFinite(currentPnlPct)) {
    return { watch, samples, action: null, reason: null };
  }

  const windowMs = (cfg.fastDropWindowMinutes ?? 15) * 60_000;
  const triggerPct = cfg.fastDropTriggerPct ?? 15;
  const bouncePct = cfg.fastDropBouncePct ?? 10;
  const hardFloorPct = cfg.fastDropHardFloorPct ?? -25;

  const factor = toFactor(currentPnlPct);

  // Append this sample, then drop anything older than the window.
  const kept = [...samples, { ts: now, factor }].filter((s) => now - s.ts <= windowMs);

  // ── Watching: look for an exit ─────────────────────────────────────
  if (watch?.active) {
    const lowFactor = Math.min(watch.lowFactor, factor); // keep trailing the bottom
    const nextWatch = { ...watch, active: true, lowFactor };

    // 1. Hard floor
    if (currentPnlPct <= hardFloorPct) {
      return {
        watch: nextWatch, samples: kept, action: "FAST_DROP_EXIT",
        reason: `Fast-drop hard floor: PnL ${currentPnlPct.toFixed(2)}% <= ${hardFloorPct}%`,
      };
    }
    // 2. Bounce off the low
    if (factor >= lowFactor * (1 + bouncePct / 100)) {
      const bounced = (factor / lowFactor - 1) * 100;
      return {
        watch: nextWatch, samples: kept, action: "FAST_DROP_EXIT",
        reason: `Fast-drop bounce exit: +${bounced.toFixed(2)}% off low (>= ${bouncePct}%), PnL ${currentPnlPct.toFixed(2)}%`,
      };
    }
    // 3. Breakeven
    if (currentPnlPct >= 0) {
      return {
        watch: nextWatch, samples: kept, action: "FAST_DROP_EXIT",
        reason: `Fast-drop breakeven exit: PnL recovered to ${currentPnlPct.toFixed(2)}%`,
      };
    }
    return { watch: nextWatch, samples: kept, action: null, reason: null };
  }

  // ── Idle: arm the watch on a sharp drop from the rolling high ──────
  const highFactor = Math.max(...kept.map((s) => s.factor));
  const dropFromHighPct = (factor / highFactor - 1) * 100;
  if (dropFromHighPct <= -triggerPct) {
    return {
      watch: { active: true, lowFactor: factor, enteredAt: now },
      samples: kept, action: null,
      reason: `Fast-drop armed: ${dropFromHighPct.toFixed(2)}% from rolling high (<= -${triggerPct}%)`,
    };
  }

  return { watch: watch ?? { active: false }, samples: kept, action: null, reason: null };
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test-fast-drop-guard.js`
Expected: PASS — all tests green.

**Step 5: Commit**

```bash
git add -f fast-drop-guard.js test-fast-drop-guard.js
git commit -m "feat(risk): fast-drop recovery-exit guard (pure module + tests)"
```

---

## Task 2: Add config keys

**Files:**
- Modify: `config.js:236-247` (management section, near the trailing/dynamic-stop keys)

**Step 1: Add the keys**

In `config.js`, inside the `management: { ... }` block, after the `pnlSanityMaxDiffPct` line (245), add:

```js
    // Fast-drop recovery-exit guard (NORMAL positions only). Detects a sharp value
    // drop from a rolling high, then exits into a bounce / at breakeven / at a hard
    // floor instead of dumping at the bottom. See fast-drop-guard.js.
    fastDropGuardEnabled:  u.fastDropGuardEnabled  ?? true,
    fastDropWindowMinutes: u.fastDropWindowMinutes ?? 15,   // rolling-high lookback
    fastDropTriggerPct:    u.fastDropTriggerPct    ?? 15,   // drop-from-high that arms watch
    fastDropBouncePct:     u.fastDropBouncePct     ?? 10,   // rise-from-low that triggers exit
    fastDropHardFloorPct:  u.fastDropHardFloorPct  ?? -25,  // force-close floor while watching
```

**Step 2: Verify config loads**

Run: `node -e "import('./config.js').then(m => console.log(m.config.management.fastDropTriggerPct, m.config.management.fastDropHardFloorPct))"`
Expected: `15 -25`

**Step 3: Commit**

```bash
git add config.js
git commit -m "feat(risk): add fast-drop guard config keys (management)"
```

---

## Task 3: Wire the guard into updatePnlAndCheckExits

**Files:**
- Modify: `state.js` (import at top; call inside `updatePnlAndCheckExits`, `state.js:417` region)

**Step 1: Add the import**

At the top of `state.js`, alongside the other local imports, add:

```js
import { evaluateFastDropGuard } from "./fast-drop-guard.js";
```

**Step 2: Call the guard before the stop-loss block**

In `updatePnlAndCheckExits` (`state.js:377`), immediately BEFORE the `// ── Stop loss ──` block (currently line 417), insert:

```js
  // ── Fast-drop recovery-exit guard (NORMAL only) ────────────────────
  // Skip when pnl is suspicious (same rule as every PnL-based exit below).
  if (mgmtConfig.fastDropGuardEnabled && !pnl_pct_suspicious) {
    const fd = evaluateFastDropGuard({
      samples: pos.fast_drop_samples || [],
      watch: pos.fast_drop_watch || null,
      currentPnlPct,
      now: Date.now(),
      cfg: mgmtConfig,
    });
    // Persist rolling samples + watch state so an active watch survives restarts.
    pos.fast_drop_samples = fd.samples;
    pos.fast_drop_watch = fd.watch;
    save(state);
    if (fd.action) {
      return { action: fd.action, reason: fd.reason };
    }
    if (fd.reason && pos.fast_drop_watch?.active && !pos._fast_drop_armed_logged) {
      pos._fast_drop_armed_logged = true;
      save(state);
      log("state", `Position ${position_address} ${fd.reason}`);
    } else if (!pos.fast_drop_watch?.active && pos._fast_drop_armed_logged) {
      pos._fast_drop_armed_logged = false;
      save(state);
    }
  }
```

Note: placing the guard BEFORE the absolute stop-loss means a fast-drop hard-floor (-25%) fires before the -50% stop, which is the intent. The other exits (OOR, trailing) remain untouched below it.

**Step 3: Sanity-check state.js parses**

Run: `node -e "import('./state.js').then(() => console.log('state.js OK'))"`
Expected: `state.js OK`

**Step 4: Commit**

```bash
git add state.js
git commit -m "feat(risk): evaluate fast-drop guard in updatePnlAndCheckExits + persist watch state"
```

---

## Task 4: Make `FAST_DROP_EXIT` a recognized exit reason in the poll (verify + label)

**Files:**
- Read/verify: `index.js:1583-1607` (30s poll exit handling)

**Step 1: Confirm no code change is needed**

The 30s poll (`index.js:1584`) treats ANY non-null `exit` uniformly: it triggers a management cycle (or a spectate "WOULD close" alert) using `exit.reason`. `FAST_DROP_EXIT` needs no special-casing there — `exit.reason` already carries a human-readable string.

The only branch that special-cases an action is `TRAILING_TP` (needs 15s confirmation, `index.js:1585`). `FAST_DROP_EXIT` should close promptly (a fast dump), so it must NOT be added to that branch. **No change required** — verify by reading the block.

**Step 2: Verification (manual reasoning, no test)**

Confirm:
- `updatePnlAndCheckExits` can return `{ action: "FAST_DROP_EXIT", reason }`.
- `index.js:1584` `if (exit)` catches it → triggers management / spectate alert.
- It is NOT caught by the `TRAILING_TP` branch (`index.js:1585`).

No commit (no change). If a reviewer prefers an explicit allowlist, that is out of scope.

---

## Task 5: Document in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (add a section after "Loss Quarantine + Min-Token-Age Deploy Gate (July 2026)")

**Step 1: Add the section**

```markdown
## Fast-Drop Recovery-Exit Guard (July 2026)

**Why**: The book is single-sided SOL and we want stability, not big dumping. The absolute
`stopLossPct` (-50%) is a *level*, not a *rate* — it does nothing when a position falls fast
while still above -50%. This guard adds a velocity signal, but avoids panic-selling at the
bottom: after a sharp drop it waits to exit into a bounce.

- **Module**: `fast-drop-guard.js` — pure/dependency-injected (mirrors `sol-crash-guard.js`).
  `evaluateFastDropGuard({ samples, watch, currentPnlPct, now, cfg })` → `{ watch, samples, action, reason }`.
  Value proxy is `factor = 1 + pnl_pct/100` (IL + price + fees).
- **State machine (per position, NORMAL only)**: track a rolling `fastDropWindowMinutes` (15m)
  buffer of value samples. Arm a "recovery watch" when value drops ≥ `fastDropTriggerPct` (15%)
  from the rolling high. While watching, keep trailing the low; exit (`FAST_DROP_EXIT`) on any of:
  value bounces ≥ `fastDropBouncePct` (10%) off the low, PnL returns to breakeven (≥0%), or PnL
  hits the `fastDropHardFloorPct` (-25%) hard floor.
- **Integration**: `state.js updatePnlAndCheckExits()` evaluates it each 30s poll (before the
  absolute stop-loss) and persists `fast_drop_samples` + `fast_drop_watch` in `state.json` so an
  active watch survives restarts (~15m sample re-warm after a restart). The returned
  `FAST_DROP_EXIT` flows through the existing 30s-poll close/alert path (spectate "WOULD close"
  + management trigger) unchanged. Skipped when `pnl_pct_suspicious`. Degen exempt
  (`buildDegenMgmtConfig()` never sets `fastDropGuardEnabled`).
- **Config (`config.management`)**: `fastDropGuardEnabled` (true), `fastDropWindowMinutes` (15),
  `fastDropTriggerPct` (15), `fastDropBouncePct` (10), `fastDropHardFloorPct` (-25). All via `update_config`.
- **Tests**: `test-fast-drop-guard.js` (node:test) — arm/no-arm, trailing low, bounce/breakeven/floor exits, window expiry, disabled, null-pnl skip.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document fast-drop recovery-exit guard in CLAUDE.md"
```

---

## Final verification

Run the full new test file once more and confirm green:

```bash
node --test test-fast-drop-guard.js
```
Expected: all tests pass.

Confirm the touched modules still import cleanly:

```bash
node -e "Promise.all([import('./config.js'), import('./state.js'), import('./fast-drop-guard.js')]).then(() => console.log('all import OK'))"
```
Expected: `all import OK`

---

## Out of scope (YAGNI)

- Degen support (explicitly normal-only per design).
- A dedicated Telegram command to toggle the guard (use `update_config`).
- Backfilling samples from `pool-memory` snapshots on restart (15m re-warm is acceptable).
- Changing the existing stop-loss / OOR / trailing-TP behavior.
