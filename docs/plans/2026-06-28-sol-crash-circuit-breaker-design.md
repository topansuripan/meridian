# SOL-Crash Circuit Breaker — Design

**Date:** 2026-06-28
**Status:** Approved (design); pending implementation plan
**Branch:** feature/degen-mode

## Motivation

Analysis of the worst PnL day in June (June 25 WIB, −$10.52 net) showed the loss
was **not** a screening or management failure. All 14 positions that day had 100%
range efficiency. The losses tracked **SOL/USD** almost 1:1:

- Pearson r between each position's SOL-move-over-hold and its PnL% = **0.863**
  (R² = 0.745 → SOL alone explained 75% of the day's PnL variance).
- Beta to SOL ≈ **0.96** (expected for single-sided SOL LP).
- SOL-beta attribution = **−$12.10** of the −$10.52 total — i.e. the book's
  *token-specific* PnL was slightly positive; the entire loss came from SOL
  depreciating (SOL fell from a $69.35 high to a $64.90 low, −6.4%).
- 3 of the 4 stop-losses (Daemon, ZERO, FLKR) were SOL-driven; only Merlin was a
  genuine token-specific loss.

Because positions are single-sided SOL and the stop-loss is denominated in **USD**,
a ~5% SOL/USD drop trips the −5% stop on essentially any in-range position
regardless of token quality. On a SOL-down day the agent mechanically liquidates
fundamentally-fine positions at the SOL bottom.

**The feature:** detect a market-wide SOL crash, exit normal positions to a
stablecoin (the only thing that escapes SOL/USD risk), and pause until SOL
stabilizes.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Capital destination on trip | **Convert to USDC** (only option that escapes SOL/USD drawdown) |
| "Dumping hard" definition | **SOL ≤ −3% in 1h OR ≤ −5% below trailing 6h high** |
| Re-entry | After 6h, re-buy SOL + resume **only if SOL stabilized**; else stay parked, re-check each cycle |
| Scope | **Normal positions only** — degen keeps running on its own circuit breaker |
| Trigger | Hybrid: evaluated each management cycle (fires right after a stop-loss; also a catch-all) |
| Architecture | **New dedicated module** `sol-crash-guard.js` (existing loss-streak breaker untouched) |

Threshold calibration (CoinGecko hourly, Jun 24–28): normal 1h move is ±1%
(stdev 0.99%); a 1h drop ≥3% happened exactly once all week (the −4.57% crash);
≥5% never. Only 2 distinct dump episodes all week, both on Jun 25. The chosen
threshold trips on both and on nothing else.

## Architecture & State

New module **`sol-crash-guard.js`**, single responsibility. State persisted to
**`sol-crash-state.json`**:

```jsonc
{
  "priceHistory": [[ms, price], ...],   // rolling, trimmed to ~7h (~6 samples/hr)
  "breaker": {
    "active": false,
    "trippedAt": null,
    "cooldownUntil": null,              // = trippedAt + cooldownHours
    "reason": null,                     // e.g. "SOL -4.6% in 1h"
    "solAtTrip": null,
    "closedPositions": [],              // for the Telegram report
    "usdcParked": null
  }
}
```

New config section **`config.solCrashGuard`** (defaults in `config.js`, override
in VPS `user-config.json`):

```jsonc
{
  "enabled": true,
  "drop1hPct": 3,            // trip if 1h drop >= this (%)
  "drawdown6hPct": 5,        // trip if drawdown vs trailing 6h high >= this (%)
  "cooldownHours": 6,
  "reentryRequiresStable": true,
  "scope": "normal",         // "normal" | "all"
  "keepGasReserveSol": 0.2,  // mirror config.management.gasReserve
  "backfillOnStart": true
}
```

## Behavior / State Machine

- **Sampling:** each management cycle, `recordSolPrice(balances.sol_price)` — SOL
  price is already fetched in the cycle, so no new RPC/API call. Buffer trimmed to
  ~7h.
- **Startup backfill:** `backfillSolHistory()` pulls ~24h hourly SOL/USD from
  CoinGecko so the 1h/6h windows are valid immediately after a PM2 restart. Plain
  HTTPS works on the Linux VPS (the TLS-revocation quirk is local-Windows only).
- **Detection** `evaluateSolCrash()`:
  - `drop1h = priceNow / priceClosestTo(now − 1h) − 1`
  - `drawdown6h = priceNow / max(prices in last 6h) − 1`
  - `dumping = drop1h ≤ −drop1hPct OR drawdown6h ≤ −drawdown6hPct`
  - **Fail-safe:** if < ~55 min of history AND backfill failed → return
    `dumping = false` (never trip blind).
- **Trip** (scope = normal):
  1. Set `active`, `trippedAt`, `cooldownUntil = now + cooldownHours`, `reason`,
     `solAtTrip`.
  2. Close every **normal** open position (degen untouched). `close_position`
     already auto-swaps the base token to SOL.
  3. Swap freed SOL → USDC, leaving `keepGasReserveSol` in SOL.
  4. Record `closedPositions` + `usdcParked`; persist; Telegram notify.
- **Cooldown + re-entry:** while `active`, normal deploys/screening are blocked.
  Once `now ≥ cooldownUntil`, each cycle re-runs `evaluateSolCrash()`:
  - still dumping → stay parked, re-check next cycle (no fixed extension);
  - stabilized → swap USDC → SOL, clear breaker, notify; normal deploys resume.

## Wiring (3 integration points)

1. **Management cron** — `index.js` `runManagementCycle()` (defined at :433, cron
   at :1423; guarded by `_managementBusy`). Near the end of the cycle:
   `recordSolPrice(...)` → if `active` then `tryReenter()` else `maybeTrip()`. An
   in-flight `tripping` flag prevents double-trip across overlapping cycles. Hooks
   into the **normal** cycle only — degen's `runDegenManagementCycle()` (:1409) is
   left alone.
2. **Deploy gate** — `executor.js` `runSafetyChecks()` (:999). Refuse a **normal**
   `deploy_position` (`isDegen = !!args.degen`, :1057) when
   `solCrashGuard.isCoolingDown()`; degen deploys pass.
3. **Screening gate** — `index.js` (:702 and :2135). Add
   `|| solCrashGuard.isCoolingDown()` alongside the existing
   `lossBreaker.triggered` check so normal screening pauses.

Normal vs degen positions are distinguished via `getTrackedPosition(p)?.degen`
(state.js); open positions via `getTrackedPositions(true)` (state.js:323).

## Error Handling

- Failed `close_position`: retry once, then continue with the remaining positions
  (one bad position must not block the liquidation); record failures; notify.
- Failed SOL→USDC swap: keep breaker `active` (positions are at least out of LP),
  retry next cycle.
- Failed USDC→SOL re-entry swap: stay parked, retry next cycle, notify.
- Backfill failure: log and degrade gracefully — buffer fills organically; detection
  is simply unavailable until ~1h of samples exist.
- `DRY_RUN`: skip real closes/swaps but exercise the full state machine + telemetry.

## Telemetry

- Trip: `🛑 SOL-crash breaker TRIPPED — SOL {reason}. Closed {n} normal positions,
  parked ${usdc} USDC. Cooldown until {HH:MM} WIB.`
- Re-entry: `✅ SOL-crash breaker CLEARED — SOL stabilized at ${price}. Swapped
  ${usdc}→SOL, resuming normal deploys.`
- Extended cooldown: a single quiet log line per cycle (avoid Telegram spam).
- Actions written to the `logger.js` audit trail.

## Testing

- Unit: `evaluateSolCrash` on synthetic buffers — flat, 1h-crash, 6h-bleed,
  insufficient-data (fail-safe).
- Unit: state machine — trip → cooldown → still-dumping (stays parked) →
  stabilized → re-enter.
- Unit: **normal-only scope** — assert degen positions are never closed.
- Replay: feed the real June 25 SOL buffer (`cg-sol.json`, saved) and assert the
  breaker trips around the 20:00–21:00 WIB crash and parks the normal book.
- DRY_RUN smoke test through the management cycle.

## Out of Scope (YAGNI)

- Denominating per-position PnL/stop-loss in SOL terms (a separate, larger change).
- A dedicated `/breaker` Telegram command (status can surface in the daily briefing;
  add later if needed).
- Applying the guard to degen (explicitly excluded by the scope decision).
- Hedging beyond a flat USDC park (no shorting / no partial sizing).
