# Spectate Mode — Design

**Date:** 2026-06-28
**Status:** Approved (design); pending implementation plan
**Branch:** feature/degen-mode

## Motivation

The operator wants a "watch only" mode: the management cycle keeps running and
monitoring (positions, PnL, OOR, would-be exits) but the agent takes **no action
at all** — no stop-loss, no take-profit, no closes, no new deploys, no claims/
swaps, and the SOL-crash breaker does not auto-close. The operator watches price/
chart manually and makes every move themselves, while still receiving alerts that
tell them *when* they'd want to act.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Scope | **Pure observe** — block ALL fund/position actions (close, deploy, claim, swap), pause screening/deploys, and stand down the SOL-crash breaker. Monitoring keeps running. |
| Alerts | Detect would-be SL/TP/OOR and **send "WOULD …" alerts, but do not act**. |
| Toggle | **`/spectate on\|off`** Telegram command, persisted to `user-config.json` (survives restart). Bare `/spectate` reports state. |
| Breaker interaction | Spectate **fully overrides** the SOL-crash breaker (no auto-close even in a crash). |
| Degen | Degen is **also frozen** (the chokepoint is mode-agnostic). |
| Architecture | **Approach A:** hard chokepoint enforcement in `executeTool` + alert-redirect/short-circuit at decision sites. |

## Architecture (Approach A)

Two layers — a hard guarantee plus clean behavior:

### Layer 1 — Enforcement chokepoint (backstop)
In `executeTool` (tools/executor.js), before executing any `WRITE_TOOLS` member
(`deploy_position`, `close_position`, `claim_fees`, `swap_token`), if
`config.spectateMode` is true → return `{ blocked: true, reason: "Spectate mode —
action suppressed" }` and log it. Placed next to the existing `runSafetyChecks`
block. This guarantees nothing touches funds regardless of caller (LLM agent,
deterministic rules, SOL-crash breaker). Read-only tools are unaffected.

### Layer 2 — Decision-site guards (avoid wasted attempts; produce clean alerts)
- **PnL-poll exit detection** (index.js poll using `updatePnlAndCheckExits` /
  `getDeterministicCloseRule`): when spectating, instead of triggering a
  management→close, send `👁 WOULD close: <pair> — <reason> (PnL <x>%)`. Deduped
  per position+reason via the existing `shouldSendAlert(key, cooldownMs)` (state.js)
  so it doesn't repeat every poll.
- **`runManagementCycle`** (index.js): still runs the monitoring phase (positions,
  PnL, OOR detection, pool-memory snapshots, OOR alerts) but **skips invoking the
  MANAGER LLM agent** when spectating — nothing it can do, and it saves tokens.
- **SOL-crash `tick`** (sol-crash-guard.js / its call site): still records the SOL
  price sample for continuity, but skips `maybeTrip`/`tryReenter` when spectating;
  if a trip *would* have fired, emit `⚠️ WOULD trigger SOL-crash breaker (<reason>)`
  once. (Implementation note: keep the guard mode-aware either by checking
  `config.spectateMode` in the tick call site in index.js, or by passing a flag —
  prefer the call site so `sol-crash-guard.js` stays free of the spectate concept.)
- **Screening gates** (both sites in index.js — `runScreeningCycle` ~750,
  `runDeterministicScreen` ~2185): add `|| config.spectateMode` to the existing
  pause condition (same pattern as the SOL-crash gate) so no new candidates are
  presented or deployed.

### Config & toggle
- `config.spectateMode` (boolean, default `false`), read as `u.spectateMode ?? false`
  in config.js.
- `/spectate on` → set `config.spectateMode = true`, persist to `user-config.json`,
  reply with confirmation + what's suppressed. `/spectate off` → reverse. `/spectate`
  → report current state + open-position count. Persist via the same path
  `update_config` uses. Handler lives in index.js alongside `/positions`, `/close`,
  `/set`.

## Error Handling / Edge Cases
- Toggling on with positions open is fine — they simply freeze; the operator manages
  them manually. Toggling off resumes normal automation on the next cycle.
- `shouldSendAlert` dedup prevents alert spam from the frequent PnL poll.
- If config persistence fails, the live `config.spectateMode` mutation still takes
  effect for the running process; log the persistence failure (degrade gracefully).
- DRY_RUN is orthogonal: spectate blocks the *decision to act* regardless of DRY_RUN.

## Testing (node:test)
- `executeTool` blocks each `WRITE_TOOLS` member when `spectateMode` is true and
  allows them when false (**the critical money-guarantee test**).
- Read-only tools (e.g. `get_position_pnl`, `get_wallet_balance`) still pass while
  spectating.
- The would-be-exit path emits an alert and does NOT call `close_position`.
- `/spectate` toggles `config.spectateMode` and persists it.
- SOL-crash `tick` does not trip while spectating (records price, no close).

## Out of Scope (YAGNI)
- A separate monitor-only loop (Approach C) — rejected; reuse the existing cycle.
- Per-position spectate (whole-agent only).
- Auto-expiry / scheduled spectate windows.
