# Pump Entry Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reject normal LP entries when the candidate token has pumped sharply in the recent past (≥20% in any single 5m candle, or ≥30% over any 15m window, within the trailing 2 hours) — a wash-trading / parabolic tell that caused the ALON −$6.30 loss on 2026-06-29.

**Architecture:** A pure detection helper (`detectRecentPump`) scans 5m OHLCV candles fetched from Meteora over a trailing window. It is wired into two layers (mirroring how volatility/TVL are checked in both): the screening filter in `getTopCandidates` (drops pumped candidates pre-LLM, degen-exempt via overrides) and the authoritative deploy gate in `runSafetyChecks` (normal deploys only). Config-driven, `null` disables, no cooldown, missing data never rejects.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict` (run files directly with `node test/<file>.js`), Meteora DLMM OHLCV REST API.

**Design doc:** `docs/plans/2026-06-29-pump-entry-guard-design.md`

---

## Background notes for the implementer

- **No formal test runner.** Tests are plain Node scripts using `node:test`. Run a test file with `node test/test-pump-guard.js`. `npm test` is only a syntax check (`node --check`).
- **Real fixtures already captured** (the OHLCV API does not retain this history, so do not try to re-fetch):
  - `test/fixtures/alon-pre-entry-5m.json` — ALON 00:00→03:00 UTC, 37 candles. The 2h before our losing entry. Contains the **+24.5% single candle at 02:35** and a **+43% 15m rise**. → MUST be detected as a pump.
  - `test/fixtures/alon-post-dump-5m.json` — ALON trailing-2h-from-now, 25 candles, the post-collapse phase (max up candle +4.1%). → MUST NOT be detected as a pump.
  - Both files are the raw API shape: `{ start_time, end_time, timeframe, data: [{ timestamp, timestamp_str, open, high, low, close, volume }, ...] }`.
- **OHLCV endpoint:** `https://dlmm.datapi.meteora.ag/pools/<pool>/ohlcv?timeframe=5m&start_time=<unixSec>&end_time=<unixSec>`. Passing the explicit window returns the full ~24 candles over 2h (the no-param default caps at 10). Only `5m` and `1h` timeframes work.
- **Scope rule:** normal deploys/screens enforce the guard; degen is exempt. Degen screening calls `getTopCandidates({ screeningOverrides: buildDegenScreeningOverrides() })`; the deploy gate already has an `isDegen` boolean.

---

## Task 1: Config keys

**Files:**
- Modify: `config.js` (screening defaults block ~line 139, runtime-apply block ~line 429)
- Modify: `user-config.example.json` (screening section)
- Test: `test/test-pump-guard.js` (create)

**Step 1: Write the failing test**

Create `test/test-pump-guard.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.screening has pump-guard defaults", () => {
  const s = config.screening;
  assert.equal(s.maxPump5mPct, 20);
  assert.equal(s.maxPump15mPct, 30);
  assert.equal(s.pumpLookbackHours, 2);
});
```

**Step 2: Run test to verify it fails**

Run: `node test/test-pump-guard.js`
Expected: FAIL — `maxPump5mPct` is `undefined`, not `20`.

**Step 3: Implement — add the keys**

In `config.js`, inside `screening: { ... }` immediately after the `athFilterPct` line (~139):

```js
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    // Pump entry guard — reject entries after a sharp recent pump (wash/parabolic tell). null = off.
    maxPump5mPct:       u.maxPump5mPct        ?? 20,  // reject if any single 5m candle in lookback rose >= this %
    maxPump15mPct:      u.maxPump15mPct       ?? 30,  // reject if any rolling 15m (3-candle) window rose >= this %
    pumpLookbackHours:  u.pumpLookbackHours   ?? 2,   // trailing window of 5m candles to scan
```

In `config.js` runtime-apply block, after the `athFilterPct` apply line (~429):

```js
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxPump5mPct      !== undefined) s.maxPump5mPct     = fresh.maxPump5mPct;
    if (fresh.maxPump15mPct     !== undefined) s.maxPump15mPct    = fresh.maxPump15mPct;
    if (fresh.pumpLookbackHours !== undefined) s.pumpLookbackHours = fresh.pumpLookbackHours;
```

In `user-config.example.json`, add to the screening section (match surrounding style):

```json
    "maxPump5mPct": 20,
    "maxPump15mPct": 30,
    "pumpLookbackHours": 2,
```

**Step 4: Run test to verify it passes**

Run: `node test/test-pump-guard.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add config.js user-config.example.json test/test-pump-guard.js
git commit -m "feat(screening): add pump-guard config keys (maxPump5mPct/maxPump15mPct/pumpLookbackHours)"
```

---

## Task 2: Pure detection helper `detectRecentPump`

**Files:**
- Modify: `tools/screening.js` (add exported `detectRecentPump` + `fetchPoolOhlcv`)
- Test: `test/test-pump-guard.js`

**Step 1: Write the failing tests (real ALON fixtures)**

Append to `test/test-pump-guard.js`:

```js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectRecentPump } from "../tools/screening.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(__dir, "fixtures", f), "utf8")).data;

test("detectRecentPump: ALON pre-entry window is flagged (the loss)", () => {
  const r = detectRecentPump(load("alon-pre-entry-5m.json"), { maxSingle5mPct: 20, max15mPct: 30 });
  assert.equal(r.pumped, true);
  assert.ok(r.maxSingle5mPct >= 24, `expected ~24.5, got ${r.maxSingle5mPct}`);
  assert.ok(r.max15mPct >= 40, `expected ~43, got ${r.max15mPct}`);
});

test("detectRecentPump: ALON post-dump window is NOT flagged", () => {
  const r = detectRecentPump(load("alon-post-dump-5m.json"), { maxSingle5mPct: 20, max15mPct: 30 });
  assert.equal(r.pumped, false);
});

test("detectRecentPump: +25% threshold would MISS ALON (single 24.5%)", () => {
  // Documents why we chose 20, not 25.
  const r = detectRecentPump(load("alon-pre-entry-5m.json"), { maxSingle5mPct: 25, max15mPct: 999 });
  assert.equal(r.pumped, false);
});

test("detectRecentPump: empty/insufficient candles never pumps", () => {
  assert.equal(detectRecentPump([], { maxSingle5mPct: 20, max15mPct: 30 }), null);
  assert.equal(detectRecentPump(null, { maxSingle5mPct: 20, max15mPct: 30 }), null);
});

test("detectRecentPump: disabled thresholds (null) never pump", () => {
  const r = detectRecentPump(load("alon-pre-entry-5m.json"), { maxSingle5mPct: null, max15mPct: null });
  assert.equal(r.pumped, false);
});
```

**Step 2: Run to verify it fails**

Run: `node test/test-pump-guard.js`
Expected: FAIL — `detectRecentPump` is not exported.

**Step 3: Implement in `tools/screening.js`**

Add near the other exported helpers:

```js
const METEORA_OHLCV_BASE = "https://dlmm.datapi.meteora.ag";

/**
 * Fetch a pool's 5m OHLCV candles over a trailing window.
 * Passing explicit start/end returns the full ~24 candles for 2h (default caps at 10).
 * Returns the candle array (oldest→newest) or null on failure / no data.
 */
export async function fetchPoolOhlcv(poolAddress, { timeframe = "5m", lookbackHours = 2, now = null } = {}) {
  if (!poolAddress) return null;
  const end = Number.isFinite(now) ? Math.floor(now) : Math.floor(Date.now() / 1000);
  const start = end - Math.round(lookbackHours * 3600);
  const url = `${METEORA_OHLCV_BASE}/pools/${poolAddress}/ohlcv?timeframe=${encodeURIComponent(timeframe)}&start_time=${start}&end_time=${end}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OHLCV ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.data) ? data.data : null;
}

/**
 * Pure pump detector. Scans 5m candles for the largest single-candle rise (close/open)
 * and the largest rolling 15m (3-candle) rise. Returns null when there is no usable data
 * (caller treats null as "allow"). Drops and flat/zero-volume candles are ignored as pumps.
 */
export function detectRecentPump(candles, { maxSingle5mPct, max15mPct } = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let maxSingle = 0, maxSingleAt = null;
  for (const c of candles) {
    const o = Number(c?.open), cl = Number(c?.close);
    if (!(o > 0) || !(cl > 0)) continue;
    const rise = (cl / o - 1) * 100;
    if (rise > maxSingle) { maxSingle = rise; maxSingleAt = c.timestamp_str || c.timestamp || null; }
  }

  let max15m = 0, max15mAt = null;
  for (let i = 2; i < candles.length; i++) {
    const base = Number(candles[i - 2]?.open), top = Number(candles[i]?.close);
    if (!(base > 0) || !(top > 0)) continue;
    const rise = (top / base - 1) * 100;
    if (rise > max15m) { max15m = rise; max15mAt = candles[i].timestamp_str || candles[i].timestamp || null; }
  }

  const single = Number.isFinite(maxSingle5mPct) && maxSingle5mPct != null && maxSingle >= maxSingle5mPct;
  const fifteen = Number.isFinite(max15mPct) && max15mPct != null && max15m >= max15mPct;

  return {
    pumped: single || fifteen,
    maxSingle5mPct: Number(maxSingle.toFixed(1)),
    max15mPct: Number(max15m.toFixed(1)),
    at: single ? maxSingleAt : (fifteen ? max15mAt : null),
  };
}
```

**Step 4: Run to verify it passes**

Run: `node test/test-pump-guard.js`
Expected: PASS (all detectRecentPump tests).

**Step 5: Commit**

```bash
git add tools/screening.js test/test-pump-guard.js
git commit -m "feat(screening): add detectRecentPump + fetchPoolOhlcv helpers (tested on real ALON candles)"
```

---

## Task 3: Deploy-gate enforcement (authoritative, normal-only)

**Files:**
- Modify: `tools/executor.js` (`runSafetyChecks`, `deploy_position` case, near the SOL-crash block ~line 1072)
- Test: manual / DRY_RUN smoke (no unit harness for the gate; covered by reasoning + syntax check)

**Step 1: Add the guard**

In `tools/executor.js`, ensure `detectRecentPump` and `fetchPoolOhlcv` are imported from `./screening.js` (add to the existing screening import if present, else a new import).

Immediately after the existing SOL-crash block:

```js
      // SOL-crash breaker: block NORMAL deploys while parked (degen unaffected)
      if (!isDegen && solGuardCoolingDown()) {
        return { pass: false, reason: "SOL-crash circuit breaker active — normal deploys paused until SOL stabilizes." };
      }
```

insert:

```js
      // Pump entry guard: refuse NORMAL deploys when the token pumped sharply in the recent window
      // (wash/parabolic tell — see ALON loss 2026-06-29). Degen is exempt; missing data never blocks.
      if (!isDegen) {
        const maxSingle5mPct = numberOrNull(config.screening.maxPump5mPct);
        const max15mPct = numberOrNull(config.screening.maxPump15mPct);
        if (maxSingle5mPct != null || max15mPct != null) {
          try {
            const candles = await fetchPoolOhlcv(args.pool_address, {
              lookbackHours: numberOrNull(config.screening.pumpLookbackHours) ?? 2,
            });
            const pump = detectRecentPump(candles, { maxSingle5mPct, max15mPct });
            if (pump?.pumped) {
              return {
                pass: false,
                reason: `Recent pump: +${pump.maxSingle5mPct}% single 5m candle / +${pump.max15mPct}% in 15m (at ${pump.at}) within ${config.screening.pumpLookbackHours ?? 2}h — likely wash/parabolic. Refusing entry.`,
              };
            }
          } catch (e) {
            log("safety_check", `Pump guard OHLCV fetch failed for ${args.pool_address}: ${e.message} — proceeding`);
          }
        }
      }
```

**Step 2: Syntax check**

Run: `node --check tools/executor.js`
Expected: no output (valid).

**Step 3: Verify the reject path with the real fixture (sanity)**

Confirm the same helper the gate calls flags ALON — already covered by Task 2's `node test/test-pump-guard.js` (PASS). No separate run needed beyond re-running it.

**Step 4: Commit**

```bash
git add tools/executor.js
git commit -m "feat(executor): pump entry guard at deploy gate (normal-only, degen exempt)"
```

---

## Task 4: Screening-side filter + degen opt-out

**Files:**
- Modify: `tools/screening.js` (`getTopCandidates`, after the indicator-confirmation block, before the final `return`)
- Modify: `index.js` (`buildDegenScreeningOverrides` ~line 1188)

**Step 1: Degen opt-out in `index.js`**

In `buildDegenScreeningOverrides()` return object, add:

```js
    excludeHighSupplyConcentration: d.excludeHighSupplyConcentration,
    maxPump5mPct:         null,  // degen chases pumps — pump guard disabled
    maxPump15mPct:        null,
```

**Step 2: Screening filter in `getTopCandidates`**

After the indicator-confirmation block and before the final `return { candidates: eligible, ... }`, add:

```js
  // Pump entry guard — drop candidates that pumped sharply in the recent window (normal screens only).
  // Degen passes screeningOverrides with these set to null, so it is exempt.
  const pumpSingle = (screeningOverrides && "maxPump5mPct" in screeningOverrides)
    ? numeric(screeningOverrides.maxPump5mPct)
    : numeric(config.screening.maxPump5mPct);
  const pump15m = (screeningOverrides && "maxPump15mPct" in screeningOverrides)
    ? numeric(screeningOverrides.maxPump15mPct)
    : numeric(config.screening.maxPump15mPct);
  const pumpLookback = numeric(config.screening.pumpLookbackHours) ?? 2;
  if ((pumpSingle != null || pump15m != null) && eligible.length > 0) {
    const pumpResults = await Promise.allSettled(
      eligible.map((p) => fetchPoolOhlcv(p.pool, { lookbackHours: pumpLookback })),
    );
    const before = eligible.length;
    const kept = [];
    for (let i = 0; i < eligible.length; i++) {
      const p = eligible[i];
      const candles = pumpResults[i].status === "fulfilled" ? pumpResults[i].value : null;
      const pump = detectRecentPump(candles, { maxSingle5mPct: pumpSingle, max15mPct: pump15m });
      if (pump) p.recent_pump_5m_pct = pump.maxSingle5mPct; // surface to LLM as context
      if (pump?.pumped) {
        log("screening", `Pump guard: dropped ${p.name} — +${pump.maxSingle5mPct}% 5m / +${pump.max15mPct}% 15m at ${pump.at}`);
        pushFilteredReason(filteredOut, p, `recent pump +${pump.maxSingle5mPct}% 5m / +${pump.max15mPct}% 15m`);
        continue;
      }
      kept.push(p);
    }
    eligible.splice(0, eligible.length, ...kept);
    if (eligible.length < before) log("screening", `Pump guard removed ${before - eligible.length} candidate(s)`);
  }
```

**Step 3: Syntax check both files**

Run: `node --check tools/screening.js && node --check index.js`
Expected: no output.

**Step 4: Re-run the unit suite**

Run: `node test/test-pump-guard.js`
Expected: PASS (no regressions; the pure helpers are unchanged).

**Step 5: Commit**

```bash
git add tools/screening.js index.js
git commit -m "feat(screening): pump entry guard filter in getTopCandidates + degen opt-out"
```

---

## Task 5: Docs

**Files:**
- Modify: `CLAUDE.md` ("Screener Safety Checks" section + a config-table row)

**Step 1: Update CLAUDE.md**

Under "Screener Safety Checks (executor.js)", add a bullet:

```
- Recent-pump guard (NORMAL only): refuses deploy if the pool's last `pumpLookbackHours` (2h) of
  5m candles contain a single candle that rose ≥ `maxPump5mPct` (20%) or a 15m window that rose ≥
  `maxPump15mPct` (30%). Data: Meteora 5m OHLCV. Wash/parabolic tell — calibrated to the ALON loss
  (2026-06-29: +24.5% 5m candle one bar before entry → −7.53% stop). Degen exempt; missing data never blocks.
```

Add to the config-keys table:

```
| maxPump5mPct / maxPump15mPct / pumpLookbackHours | screening | 20 / 30 / 2 |
```

**Step 2: Syntax check (docs only — no code change)**

Run: `npm test` (syntax check across the repo)
Expected: passes.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document pump entry guard in CLAUDE.md"
```

---

## Done criteria

- `node test/test-pump-guard.js` → all PASS (config defaults + real-ALON detection both directions + 25%-misses-ALON regression doc + null/empty safety).
- `npm test` (syntax) → PASS.
- Manual reasoning trace: a normal deploy into a pool whose trailing 2h contains a ≥20% 5m candle is rejected at the gate; degen deploy into the same pool is allowed; OHLCV fetch failure does not block.
