# Fast-Drop Recovery-Exit Guard — Design

**Date:** 2026-07-28
**Branch:** feature/degen-mode
**Scope:** Normal positions only

## Problem

The book is single-sided SOL and we want **stability, not big dumping**. The existing
`stopLossPct` (-50% normal) is an *absolute level* — it does nothing to catch a position
that falls *fast* while still above that level. A sharp drop is a sign to look for an exit,
but panic-selling at the exact bottom is also bad.

## Concept

A **velocity-based** exit that complements the absolute stop-loss. It detects a sharp drop
from a recent high, then waits to exit *into a bounce* rather than dumping at the low — with
a hard floor so a non-bouncing dump can't bleed all the way to -50%.

## State Machine (per position)

`factor = 1 + pnl_pct/100` is used as the position's economic value proxy (captures
impermanent loss + price move + fees earned — the real LP value).

- **Idle:** each 30s poll, push `{ts, factor}` to a rolling buffer; drop samples older than
  `fastDropWindowMinutes`. Compute `rollingHighFactor = max(factor)` over the window.
  If `factor_now / rollingHighFactor - 1 <= -fastDropTriggerPct%` → **arm watch**,
  record `low = factor_now`.
- **Watching:** keep trailing `low` downward as it keeps falling. Exit (`CLOSE`) when **any**:
  1. `pnl_pct <= fastDropHardFloorPct` — hard floor, force close, or
  2. `factor_now >= low * (1 + fastDropBouncePct/100)` — bounced off the low, exit into strength, or
  3. `pnl_pct >= 0` — back to breakeven, exit flat.

## Module

`fast-drop-guard.js` — pure / dependency-injected (mirrors `sol-crash-guard.js`,
`wallet-reconcile.js`, `pool-detail-resolver.js`). No heavy imports; unit-testable.

```
evaluateFastDropGuard({ samples, watch, currentPnlPct, now, cfg })
  -> { watch, action, reason }   // action: null | "CLOSE"
```

Pure: takes prior sample buffer + watch state + current pnl, returns the updated state and
an optional action. No side effects.

## Config (new keys, `config.management`)

| Key | Default | Meaning |
|-----|---------|---------|
| `fastDropGuardEnabled` | `true` | master switch |
| `fastDropWindowMinutes` | `15` | rolling-high lookback |
| `fastDropTriggerPct` | `15` | drop-from-high that arms watch |
| `fastDropBouncePct` | `10` | rise-from-low that triggers exit |
| `fastDropHardFloorPct` | `-25` | force-close floor while watching |

All settable via `update_config`. Normal only — `buildDegenMgmtConfig()` does **not** set
these (degen keeps its -10% stop + 1m cycles).

## Integration

- **`state.js` `updatePnlAndCheckExits()`** — central exit evaluator, already has the
  position record + pnl, runs every 30s poll. Add guard evaluation here.
- Persist `fastDrop: { active, low, samples, entered_at }` in the position's `state.json`
  record so an active watch survives restarts. Sample window re-warms ~15 min after a
  restart (acceptable).
- Priority: hard-floor sits alongside stop-loss; bounce/BEP exit is returned as a normal
  `CLOSE` action like the other rules, so the existing 30s-poll close path, spectate-mode
  "WOULD close" alerts, and 15s confirmation recheck all apply for free.

## Error Handling / Safety

- Missing/`null` `pnl_pct` → skip sampling that tick (never throws, never fires).
- `pnl_pct_suspicious` (sanity-check flag) → skip, same as other PnL rules.
- Additive — existing -50% stop-loss, OOR timeout, trailing TP, dynamic stop all untouched.

## Testing

`test-fast-drop-guard.js` (node:test, `git add -f` per repo convention):
- arm on >=15% drop-from-high
- do NOT arm on slow bleed (drop spread over > window)
- trailing-low updates as it keeps falling
- exit on +10% bounce from low
- exit on return to breakeven
- hard-floor force-close while watching
- window expiry drops stale samples (rolling high recovers)
- disabled switch → no-op
