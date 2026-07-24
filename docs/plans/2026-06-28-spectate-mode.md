# Spectate Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a global "spectate" (watch-only) mode where the management cycle keeps monitoring but the agent takes no fund/position action — no SL/TP/close, no deploys, no claims/swaps, and the SOL-crash breaker stands down — while emitting "WOULD …" alerts so the operator acts manually.

**Architecture:** Approach A — a hard enforcement chokepoint in `executeTool` (blocks all `WRITE_TOOLS` when `config.spectateMode`), plus short-circuit/alert guards at the decision sites (PnL-poll exit detection, SOL-crash `tick`, management LLM step, screening gates). Toggled by a persisted `/spectate on|off` Telegram command. A pure predicate keeps the chokepoint hermetically testable; the SOL-crash module gains a generic `observeOnly` tick option so detection logic stays DRY.

**Tech Stack:** Node ≥18 ESM, `node:test` + `node:assert/strict`, existing config/telegram/cron infra.

**Design doc:** `docs/plans/2026-06-28-spectate-mode-design.md`

---

## Conventions
- Tests run with `node --test test/<file>.js`. Time-dependent funcs take explicit `now`.
- Commit after every green step. Test files need `git add -f` (broad `test-*.js` gitignore rule).
- Append to every commit message body: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `config.spectateMode` is the single source of truth; all guards read it live (it's mutated in place by the toggle).

---

### Task 1: Config flag + `setSpectateMode` persistence helper

**Files:**
- Modify: `config.js` (add `spectateMode` to the exported `config`; add `setSpectateMode` export)
- Test: `test/test-spectate.js`

**Step 1: Write the failing test**

Create `test/test-spectate.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { config, setSpectateMode } from "../config.js";

test("config.spectateMode defaults to false", () => {
  assert.equal(typeof config.spectateMode, "boolean");
});

test("setSpectateMode flips the live flag and persists, preserving other keys", () => {
  const tmp = "./test/.tmp-user-config.json";
  fs.writeFileSync(tmp, JSON.stringify({ maxPositions: 2, foo: "bar" }, null, 2));
  setSpectateMode(true, tmp);
  assert.equal(config.spectateMode, true);
  const written = JSON.parse(fs.readFileSync(tmp, "utf8"));
  assert.equal(written.spectateMode, true);
  assert.equal(written.maxPositions, 2, "preserves existing keys");
  assert.equal(written.foo, "bar");
  setSpectateMode(false, tmp);
  assert.equal(config.spectateMode, false);
  assert.equal(JSON.parse(fs.readFileSync(tmp, "utf8")).spectateMode, false);
  fs.unlinkSync(tmp);
});
```

**Step 2: Run to verify it fails**

Run: `node --test test/test-spectate.js`
Expected: FAIL — `setSpectateMode` is not exported / `config.spectateMode` undefined.

**Step 3: Implement**

In `config.js`, add to the exported `config` object (top-level, e.g. right after the opening `export const config = {` or alongside other top-level fields — NOT inside a sub-section):

```js
  spectateMode: u.spectateMode ?? false,
```

Then add this exported helper near the bottom of `config.js` (it already has `USER_CONFIG_PATH` and `fs`):

```js
/**
 * Toggle spectate (watch-only) mode: mutate the live config and persist to
 * user-config.json (preserving all other keys). `configPath` override is for tests.
 */
export function setSpectateMode(on, configPath = USER_CONFIG_PATH) {
  config.spectateMode = !!on;
  let uc = {};
  try { if (fs.existsSync(configPath)) uc = JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch { /* start from empty on parse error */ }
  uc.spectateMode = !!on;
  try { fs.writeFileSync(configPath, JSON.stringify(uc, null, 2)); }
  catch (e) { /* live flag still applied */ }
  return config.spectateMode;
}
```

> Confirm `fs` is imported at the top of `config.js` (it is — line 1). `USER_CONFIG_PATH` is defined (line 6).

**Step 4: Run to verify it passes** — Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add config.js && git add -f test/test-spectate.js
git commit -m "feat(spectate): config flag + setSpectateMode persistence"
```

---

### Task 2: Enforcement chokepoint in `executeTool`

**Files:**
- Modify: `tools/executor.js` (export a pure predicate; gate in `executeTool`)
- Test: `test/test-spectate.js` (append)

**Step 1: Write the failing tests**

```js
import { spectateWouldBlock, executeTool } from "../tools/executor.js";

test("spectateWouldBlock: true only for write tools when spectating", () => {
  config.spectateMode = true;
  for (const t of ["deploy_position", "close_position", "claim_fees", "swap_token"]) {
    assert.equal(spectateWouldBlock(t), true, `${t} should block`);
  }
  assert.equal(spectateWouldBlock("get_position_pnl"), false, "read tool not blocked");
  config.spectateMode = false;
  assert.equal(spectateWouldBlock("close_position"), false, "off → not blocked");
});

test("executeTool returns a blocked result for write tools while spectating (no execution)", async () => {
  config.spectateMode = true;
  for (const t of ["deploy_position", "close_position", "claim_fees", "swap_token"]) {
    const r = await executeTool(t, { position_address: "x", pool_address: "y" });
    assert.equal(r.blocked, true, `${t} blocked`);
    assert.match(r.reason, /spectate/i);
  }
  config.spectateMode = false;
});
```

**Step 2: Run to verify it fails** — Expected: FAIL (no `spectateWouldBlock`; write tools would otherwise try to execute).

**Step 3: Implement**

In `tools/executor.js`, after the `WRITE_TOOLS` set definition (~line 837), add:

```js
/** True when spectate mode is active AND this tool would touch funds/positions. */
export function spectateWouldBlock(name) {
  return !!config.spectateMode && WRITE_TOOLS.has(name);
}
```

In `executeTool`, immediately AFTER the `if (!fn) { ... }` unknown-tool check (~line 858) and BEFORE the `PROTECTED_TOOLS` safety block, add:

```js
  // ─── Spectate mode: suppress all fund/position actions ───
  if (spectateWouldBlock(name)) {
    log("spectate_block", `${name} suppressed (spectate mode)`);
    return { blocked: true, reason: "Spectate mode — action suppressed (no SL/TP/deploy/claim/swap). Use /spectate off to resume." };
  }
```

> `config` is already imported in executor.js. `log` is imported.

**Step 4: Run to verify it passes** — Expected: PASS (4 tests total in file).

**Step 5: Commit**

```bash
git add tools/executor.js && git add -f test/test-spectate.js
git commit -m "feat(spectate): hard chokepoint blocks write tools in executeTool"
```

---

### Task 3: SOL-crash `tick` gains a generic `observeOnly` option

**Files:**
- Modify: `sol-crash-guard.js` (`tick` accepts `observeOnly`)
- Test: `test/test-sol-crash-guard.js` (append — keep that suite green)

**Step 1: Write the failing test**

Append to `test/test-sol-crash-guard.js` (it already has `defaultState`, `hist`, `mkDeps` helpers and imports):

```js
test("tick observeOnly records price + reports wouldTrip without acting", async () => {
  const now = 10_000_000_000_000;
  __resetStateForTests();
  // seed 6 prior hours flat at 68, then a -4.6% drop to 64.9 "now"
  const g = await import("../sol-crash-guard.js");
  for (let i = 6; i >= 1; i--) g.recordSolPrice(68, now - i * 3600_000);
  const deps = mkDeps();
  const res = await g.tick({ now, solPrice: 64.9, observeOnly: true, deps });
  assert.equal(res.wouldTrip, true, "reports it would trip");
  assert.match(res.reason, /1h/);
  assert.equal(deps.closed.length, 0, "observeOnly must NOT close anything");
  assert.equal(g.isCoolingDown(now), false, "breaker not activated in observe mode");
});
```

(Use whatever import style the existing file uses; `__resetStateForTests` and `mkDeps` are already in scope there.)

**Step 2: Run to verify it fails** — Expected: FAIL (`observeOnly` ignored → it actually trips/closes).

**Step 3: Implement**

In `sol-crash-guard.js` `tick`, add `observeOnly = false` to the destructured options and branch BEFORE the active/maybeTrip logic (after `recordSolPrice`):

```js
export async function tick({ now = Date.now(), solPrice, deps, observeOnly = false }) {
  if (!config.solCrashGuard.enabled) return;
  if (_ticking) return;
  _ticking = true;
  try {
    if (Number.isFinite(solPrice)) recordSolPrice(solPrice, now);

    if (observeOnly) {
      const metrics = computeSolMetrics(_state.priceHistory, now);
      const { dumping, reason } = isDumping(metrics, config.solCrashGuard);
      saveState(_state);
      return { wouldTrip: dumping && !_state.breaker.active, reason };
    }

    // ... existing active/maybeTrip/tryReenter logic unchanged ...
    saveState(_state);
  } finally {
    _ticking = false;
  }
}
```

Keep the rest of `tick` exactly as-is.

**Step 4: Run to verify it passes** — Run: `node --test test/test-sol-crash-guard.js` → all pass (27).

**Step 5: Commit**

```bash
git add sol-crash-guard.js && git add -f test/test-sol-crash-guard.js
git commit -m "feat(spectate): sol-crash tick observeOnly option (detect, don't act)"
```

---

### Task 4: Wire spectate into the management cron (`index.js`)

**Files:**
- Modify: `index.js` — SOL-crash tick call site, the MANAGER LLM step, and the PnL-poll exit detection.

No new unit test (these are integration points exercised by the smoke test in Task 7); verify with `node --check` and the smoke test. Read each site first.

**Step 1: SOL-crash tick — observe when spectating**

In `runManagementCycle`, the `solCrashGuard.tick({ ... })` block: pass `observeOnly: config.spectateMode` and alert on `wouldTrip`. Replace the `await solCrashGuard.tick({ solPrice: bal.sol_price, deps: {...} })` call with:

```js
      const tickRes = await solCrashGuard.tick({
        solPrice: bal.sol_price,
        observeOnly: config.spectateMode,
        deps: { /* ...existing deps unchanged... */ },
      });
      if (config.spectateMode && tickRes?.wouldTrip && shouldSendAlert("spectate_breaker", 30 * 60_000)) {
        await sendMessage(`⚠️ [SPECTATE] WOULD trigger SOL-crash breaker — ${tickRes.reason}. No action taken.`).catch(() => {});
      }
```

Confirm `shouldSendAlert` is imported from `./state.js` in index.js (it's exported there at state.js:539). If not imported, add it to the existing `./state.js` import.

**Step 2: Skip the MANAGER LLM agent when spectating**

Find the `agentLoop(...)` (or equivalent LLM management) invocation inside `runManagementCycle`. Wrap it:

```js
    if (config.spectateMode) {
      log("spectate", "Management LLM step skipped (spectate mode) — monitoring only.");
    } else {
      // ... existing agentLoop(...) management call, unchanged ...
    }
```

Keep the monitoring phase BEFORE this (positions fetch, PnL, OOR detection, pool-memory snapshots) running in both modes.

**Step 3: PnL-poll would-be-exit → alert instead of triggering management**

In the 30s PnL poll (`pnlPollInterval`, ~line 1504), there are sites that, on a detected exit / deterministic close rule, call `runManagementCycle({ silent: true })`. For EACH such trigger site, guard it:

```js
            if (config.spectateMode) {
              if (shouldSendAlert(`spectate_exit:${p.position}:${exit?.reason || closeRule?.reason || "exit"}`, 20 * 60_000)) {
                await sendMessage(`👁 [SPECTATE] WOULD close ${p.pair} — ${exit?.reason || closeRule?.reason} (PnL ${p.pnl_pct ?? "?"}%). No action taken.`).catch(() => {});
              }
            } else {
              // ... existing runManagementCycle({ silent: true }) trigger, unchanged ...
            }
```

Adapt variable names (`exit`, `closeRule`, `p.pair`, `p.pnl_pct`) to the actual code at each site. There are ~2 such trigger sites in the poll — guard both.

**Step 4: Syntax check** — Run: `node --check index.js` → clean.

**Step 5: Commit**

```bash
git add index.js
git commit -m "feat(spectate): observe-only management cycle + WOULD-close alerts"
```

---

### Task 5: Pause screening when spectating (`index.js`)

**Files:**
- Modify: `index.js` — the two screening gates (`runScreeningCycle` ~750, `runDeterministicScreen` ~2185) that already check `lossBreaker.triggered || solCrashGuard.isCoolingDown()`.

**Step 1: Widen both gates**

At each site, add `|| config.spectateMode` to the condition and provide a spectate reason:

```js
    if (lossBreaker.triggered || solCrashGuard.isCoolingDown() || config.spectateMode) {
      const reason = config.spectateMode
        ? "Spectate mode — screening/deploys paused"
        : lossBreaker.triggered
          ? formatLossCircuitBreakerReason(lossBreaker)
          : "SOL-crash circuit breaker active — screening paused until SOL stabilizes";
      // ... existing pause/return handling unchanged ...
    }
```

Apply the analogous change at the `runDeterministicScreen` site (it returns a string).

**Step 2: Syntax check** — `node --check index.js` → clean.

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat(spectate): pause screening + deploys while spectating"
```

---

### Task 6: `/spectate` Telegram command (`index.js`)

**Files:**
- Modify: `index.js` — add a command handler near `/pause` (~line 2548).

**Step 1: Add the handler**

Confirm `setSpectateMode` is imported from `./config.js` (add to the existing config import if missing). Add near the `/pause` handler:

```js
  if (text === "/spectate" || text === "/spectate on" || text === "/spectate off") {
    if (text === "/spectate on" || text === "/spectate off") {
      const on = text.endsWith(" on");
      setSpectateMode(on);
      await sendMessage(
        on
          ? "👁 <b>Spectate mode ON</b> — monitoring continues, but NO actions: no SL/TP/close, no deploys, no claims/swaps, SOL-crash breaker stands down. You'll get '⚠️/👁 WOULD …' alerts. (Cycles still run — this is not /pause.)\n\nUse /spectate off to resume automation."
          : "▶️ <b>Spectate mode OFF</b> — automation resumed on the next cycle.",
        // if sendMessage doesn't parse HTML, use sendHTML(...) instead
      ).catch(() => {});
    } else {
      const bal = await getMyPositions({ silent: true }).catch(() => ({ total_positions: 0 }));
      await sendMessage(`👁 Spectate mode is ${config.spectateMode ? "ON" : "OFF"}. Open positions: ${bal.total_positions ?? "?"}.`).catch(() => {});
    }
    return;
  }
```

> Use `sendHTML(...)` if the bold tags need HTML parse mode (match how `/pause` and degen-toggle replies are sent — check the surrounding handlers and mirror them). Add `/spectate` to the `/help` text block (~line 2159) too.

**Step 2: Syntax check** — `node --check index.js` → clean.

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat(spectate): /spectate on|off|status Telegram command"
```

---

### Task 7: Docs + smoke test

**Files:**
- Modify: `CLAUDE.md` (document spectate near the SOL-crash section + add `/spectate` to the Telegram commands table)
- Modify: `user-config.example.json` (add `"spectateMode": false` if it's a config catalog)

**Step 1: Full test suite**

Run: `node --test test/test-spectate.js` (expect ~4 pass) and `node --test test/test-sol-crash-guard.js` (expect 27 pass).

**Step 2: Chokepoint smoke**

Run:
```
DRY_RUN=true node -e "import('./config.js').then(async ({config}) => { config.spectateMode = true; const { executeTool } = await import('./tools/executor.js'); const r = await executeTool('close_position', { position_address: 'X' }); console.log('blocked:', r.blocked, '| reason:', r.reason); })"
```
Expected: `blocked: true | reason: Spectate mode — ...`. (No chain call made.)

**Step 3: Syntax check everything** — `node --check config.js tools/executor.js sol-crash-guard.js index.js` → all clean.

**Step 4: Update docs**

- `CLAUDE.md`: add a short "Spectate Mode" subsection — what it suppresses (all writes + screening + breaker), that monitoring/alerts continue, that it differs from `/pause` (cycles keep running), the `/spectate on|off` toggle, the `spectateMode` config key, and the `executeTool` chokepoint + decision-site guards.
- Add `/spectate on|off` to the Telegram commands table in CLAUDE.md.
- `user-config.example.json`: add `"spectateMode": false`.

**Step 5: Commit**

```bash
git add CLAUDE.md user-config.example.json
git commit -m "docs(spectate): document spectate mode + /spectate command"
```

---

### Task 8: Deploy (gated on operator approval)

Per CLAUDE.md deploy workflow. Do NOT run without explicit go-ahead.

```bash
git push origin feature/degen-mode
ssh root@43.133.133.150 "cd ~/meridian && git pull origin feature/degen-mode && npm install && pm2 restart meridian"
```

Note: spectate defaults OFF, so deploy is low-risk (no behavior change until `/spectate on`).

---

## Validation checklist
- [ ] `node --test test/test-spectate.js` → passing
- [ ] `node --test test/test-sol-crash-guard.js` → 27 passing (observeOnly added)
- [ ] `node --check config.js tools/executor.js sol-crash-guard.js index.js` → clean
- [ ] Chokepoint smoke prints `blocked: true`
- [ ] `/spectate on` blocks a manual `/close`; `/spectate off` restores it
