# Pump Entry Guard — Reject entries after a recent short-term pump

**Date:** 2026-06-29
**Status:** Approved (design) → implementation plan next
**Author:** raihan + Claude

---

## Problem

The agent opened a normal LP position in **ALON-SOL** at ~02:41 UTC on 2026-06-29,
**one 5-minute candle after the price spiked +24.5% in a single 5m bar**, at the very
top of a +43% 15-minute rip. The token then dumped and hit the −5% stop-loss at
−7.53% (−$6.30, position `DStMhGHmw3xX3Wzsu6Lm1EHURbTjPm8iJzKGKpM4MifH`). A prior
ALON deploy the same night went out of range ("pumped far above range") in 8 minutes.

A sharp short-term pump is a strong wash-trading / pump-and-dump / parabolic tell.
Entering into the tail of one buys the local top — exactly what happened.

### Evidence (real ALON candle data, 2026-06-29)

Pool `4rQu7doLL5CtArsNjoZwy5LC8t91tYVQTaiBs9Z8M3kD`, 5m candles in the 2h **before** our entry:

| Time (UTC) | 5m O→C | Note |
|------------|--------|------|
| 00:05 | +12.7% | |
| 00:10 | +10.5% | |
| **02:35** | **+24.5%** | vol 9,510 — the spike |
| 02:41 | — | **WE DEPLOYED HERE** (vol 9.02) |
| 02:55 | — | local peak, then dump |

- **Max single 5m candle (O→C) in trailing 2h: +24.5%**
- **Max 15m (3-candle) rolling rise: +43.1%**, ending 02:40
- Macro context: ALON was +130% in one hour (28th 22:00) and +172% / 24h — a parabola.

A 5m/1h/24h *aggregate* change rule would have been noisy; the clean, decisive signal
was a **single vertical 5m candle in the recent window**.

---

## Rule

> At entry decision time, fetch the candidate pool's last **2 hours** of 5-minute candles.
> Reject the (normal) entry if **either**:
> 1. any single 5m candle rose **≥ 20%** (close-vs-open), **or**
> 2. any rolling 15-minute (3-candle) window rose **≥ 30%**.

Calibration is grounded in the ALON loss: single-candle 20% catches the +24.5% spike with
a 4.5pt margin; 15m 30% catches the +43% rip. (Note: the initially-considered +25%/5m
threshold would have **missed** ALON at 24.5% — the data drove it down to 20%.)

- **Scope: normal deploys only.** Degen mode intentionally chases pumpy tokens and runs on
  its own breaker — it is exempt.
- **No volatility cap** (considered and declined; keep this change focused on the pump rule).
- **No cooldown.** A pump is transient; once it cools the token becomes eligible again on the
  next cycle naturally. (Unlike permanent safety failures, which use `setDeployFailureCooldown`.)
- **Missing/insufficient candle data → do NOT reject** (matches the existing `is_wash` / ATH
  filters: act only on a confirmed signal, never on absent data).

---

## Data source

`https://dlmm.datapi.meteora.ag/pools/<pool>/ohlcv?timeframe=5m&start_time=<now-7200>&end_time=<now>`

- Verified: the default (no params) call caps at **10 candles (~50 min)**, but passing an explicit
  `start_time`/`end_time` window returns the **full ~24 candles over 2h** at 300s spacing.
- Verified: the endpoint supports **only `5m` and `1h`** timeframes (1m/3m/15m error out) — so a
  "true 3-minute" window is not available; 5m is the finest candle. This validates the 5m basis.
- Verified: no deep history retention (a May date returned 0 candles), but the trailing 2h is always
  available — which is all this rule needs.
- OKX DEX candle endpoints returned empty for public access; Meteora OHLCV is the source.

---

## Architecture

Mirrors the existing defense-in-depth pattern (volatility/TVL are checked in **both** screening and
the deploy gate).

### New: pure detection helper (`tools/screening.js`)

```
fetchPoolOhlcv(poolAddress, { timeframe = "5m", lookbackHours = 2 }) -> candle[] | null
detectRecentPump(candles, { maxSingle5mPct, max15mPct }) ->
    { pumped: boolean, maxSingle5mPct, max15mPct, at } | null
```

- `detectRecentPump` is pure (no I/O) → unit-testable against real ALON fixtures.
- Scans only positive rises; ignores drops and flat/zero-volume candles.
- Returns `null` (→ "no signal, allow") when fewer than 1 usable candle.

### Layer 1 — Screening filter (`getTopCandidates` in `screening.js`)

- Runs **last** in the eligible pipeline (after OKX/ATH/indicator filters) so OHLCV is only fetched
  for survivors (≤ `limit`, ~10) — minimizes calls.
- Effective thresholds read from `screeningOverrides ?? config.screening`, so **degen opts out**:
  `buildDegenScreeningOverrides()` (index.js) sets `maxPump5mPct: null` + `maxPump15mPct: null`.
- Dropped candidates recorded via `pushFilteredReason(...)`; surviving candidates get
  `recent_pump_5m_pct` surfaced for LLM context.

### Layer 2 — Deploy gate (`runSafetyChecks` `deploy_position` in `executor.js`) — authoritative

- Placed near the existing `!isDegen && solGuardCoolingDown()` block.
- When `!isDegen` and a pump threshold is configured: `fetchPoolOhlcv(args.pool_address)` →
  `detectRecentPump`. On a pump → `{ pass: false, reason: "Recent pump: +X% 5m candle at HH:MM — likely wash/parabolic. Refusing entry." }`.
- Wrapped in try/catch: if the OHLCV fetch fails, **log and proceed** (don't block on a flaky feed),
  same posture as the token-audit check.

---

## Config

Add to `config.screening` (in `config.js` defaults + `user-config.example.json`):

| Key | Default | Meaning |
|-----|---------|---------|
| `maxPump5mPct` | `20` | Reject if any single 5m candle in the trailing window rose ≥ this %. `null` = off. |
| `maxPump15mPct` | `30` | Reject if any rolling 15m (3-candle) window rose ≥ this %. `null` = off. |
| `pumpLookbackHours` | `2` | Trailing window of 5m candles to scan. |

Tunable at runtime via the existing `update_config` tool. Degen disables both via screening overrides.

---

## Testing

- **Unit (real fixtures):** capture two ALON 5m series as fixtures:
  - `alon-pre-entry` (00:00→03:00): `detectRecentPump` MUST return `pumped: true`
    (single +24.5% ≥ 20, 15m +43% ≥ 30).
  - `alon-post-dump` (02:50→04:50): MUST return `pumped: false` (max up candle +4.1%).
- Degen exemption: screening with degen overrides skips the filter.
- Missing/empty candle data → `pumped: false` / no rejection.

---

## Out of scope (YAGNI)

- Volatility cap at entry (declined for now).
- Combining pump with volume / unique-trader ratios for "true" wash detection — the dedicated OKX
  `is_wash` hard filter already exists; this rule is purely the price-velocity heuristic.
- 1h/24h aggregate "overextension" windows (considered; single-5m-candle scan over 2h was chosen as
  the cleaner, data-backed signal).

---

## Docs to update on implementation

- `CLAUDE.md` → "Screener Safety Checks" section + config table.
