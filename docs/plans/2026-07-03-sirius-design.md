# Sirius — Design

**Date:** 2026-07-03
**Status:** Approved (design), pending implementation plan
**Author:** brainstormed with operator

---

## Summary

Sirius is a new fleet sibling: a **DLMM LP signals + auto-close sidecar**. It automates the
mechanical parts of a discretionary manual strategy (Dexscreener + GMGN + Supertrend + RSI(2)/BB/MACD)
while leaving the discretionary entry to the operator.

Asymmetric by design:

- **Entry is discretionary** — Sirius *alerts* when a screened candidate breaks above the 15m
  Supertrend; the operator deploys the DLMM position by hand.
- **Exit is mechanical** — Sirius *auto-closes* a position when the TA exit confluence fires.
- **Dump is a heads-up** — Sirius *alerts* (does not close) when a position dumps, so the operator
  can bail early before the TA exit ever triggers.

The only on-chain write Sirius ever performs is **close** (plus the post-close claim/swap-to-SOL).
It has **no `deploy_position` capability** — it physically cannot open a position.

## Origin strategy (operator's manual playbook)

- **Part 1 — Coin selection:** Dexscreener filter (≥250k MC, ≥1M 24h volume), sort by age, skip
  no-picture coins; GMGN gates: fees > 30, phishing < 30%, bundling < 60%, insiders < 10%, top10 < 30%.
- **Part 2 — Entry:** 15m chart, wait for price to break above Supertrend, then open one-sided SOL
  DLMM (80/100/125 bin, −86% to −94% range).
- **Part 3 — Exit:** RSI(2) with upper limit 90. Exit on a confluence of ≥2 indicators:
  RSI(2) close > 90 **AND** (price closes above BB upper **OR** MACD prints first green histogram).

## Lineage & isolation

- Meridian-derived (Polaris-style clone): reuses LP close/claim/swap, screening, chart-indicators
  relay, Telegram, logger.
- Location: `D:\aiproject\sirius`, own git repo, own `config`/`state`/`.env`.
- **Dedicated wallet** `AREtsBPH7uPzSVp3J88VUwgHK6uzBRmEivaPN74Va7vG` — distinct from Meridian
  (`BeEGreU2nwr8bXmrsi1Tf8ALZbVWP9VomfeaEMDLmSYg`) and Polaris. The operator funds and manually
  deploys into this wallet; Sirius is the only automated process on it, so every open position on
  the wallet is "operator's, from this strategy" → safe to auto-close on signal.

## Data source (settled)

The Agent Meridian chart-indicators relay (`GET /chart-indicators/{mint}?interval=15_MINUTE&candles=298&rsiLength=2`)
returns, verified live 2026-07-03:

- `candles`: **298** entries, each `{ time, open, high, low, close, volume }`
- `latest`: `{ candle, previousCandle, rsi, bollinger, supertrend, fibonacci, states }`
- **No MACD** anywhere in the payload.

Implication: MACD must be **computed client-side** from the 298 relay closes (~35 minimum needed;
298 is ample). This is *not* the capped Meteora `dlmm.datapi` OHLCV endpoint (≈10 candles) — that pipe
is irrelevant here.

## Tool access

Allowed: `close_position`, `claim_fees`, `swap_token`, `get_my_positions`, `get_position_pnl`,
`get_top_candidates`, chart-indicators helpers.

Removed: **`deploy_position`** (not in any role set; not in `toolMap`).

## Components

### Loop 1 — Entry watcher (alert-only, every 15m)

1. `getTopCandidates` with Part-1 filters.
2. For each candidate, `fetchChartIndicatorsForMint(mint, { interval: "15_MINUTE" })`.
3. `evaluatePreset("entry", "supertrend_break", payload)` → on confirm, Telegram:
   `🎯 ENTRY: {token} broke above 15m Supertrend | MC {mc} vol {vol} | pool {addr} | bins ~[-86%..-94%]`.
4. De-dupe: one entry alert per token per cooldown window (avoid re-alerting the same break each cycle).

No wallet action. Operator deploys manually.

### Loop 2 — Exit watcher (auto-close, every management cycle)

1. `getMyPositions({ force: true })` on the dedicated wallet.
2. Per open position, `fetchChartIndicatorsForMint(baseMint, { interval: "15_MINUTE" })` (one fetch,
   reused by Loop 2b).
3. Evaluate exit preset **`ta_exit`**:
   `rsi >= 90 AND (close > bollinger.upper OR macdFirstGreen)`
   where `macdFirstGreen` = MACD histogram crossed from ≤ 0 to > 0 on the latest candle
   (`hist[n-1] <= 0 < hist[n]`).
4. On confirm: `closePosition` → swap base → SOL → Telegram
   `✅ AUTO-CLOSED {token}: {reason} (PnL {x}%)`.

**This is the only close trigger.** No stop-loss, no take-profit %, no OOR auto-close.

### Loop 2b — Dump alert (alert-only, no close)

Rides on the same 15m payload fetched in Loop 2. Fires an informational alert (throttled
one-per-position-per-cooldown) when either:

- **Price dump:** inverted pump detector — a single 15m candle down ≥ `dumpCandlePct` (default −15%),
  or a 3-candle / 45m window down ≥ `dumpWindowPct` (default −25%); and/or
- **PnL drawdown:** position PnL ≤ `dumpAlertPnlPct` (default −12%).

→ `⚠️ DUMP: {token} down {x}% (PnL {y}%) — TA exit hasn't fired, close manually?`

No close. Operator decides.

## New code

1. **MACD in `buildSignalSummary`** (`tools/chart-indicators.js`): compute EMA(12), EMA(26), MACD
   line, EMA(9) signal, histogram series over `payload.candles.map(c => c.close)`; expose
   `macdLine`, `macdSignal`, `macdHist`, `macdPrevHist`, `macdFirstGreen`.
2. **`ta_exit` exit preset** in `evaluatePreset`: `rsi >= overbought && (aboveBB || macdFirstGreen)`
   (overbought = 90 via config).
3. **Inverted dump detector** — mirror of `detectRecentPump` in `screening.js` (or a small helper),
   consuming the same candles.
4. **Wire `confirmIndicatorPreset({ side: "exit" })` into the close path** — today it is only called
   on the *entry* side (`screening.js:750`); it is never invoked on exit. The exit watcher calls it
   and acts on the result.
5. **Strip close triggers** other than TA exit: disable `stopLossPct`, `takeProfitPct`, trailing TP,
   and OOR auto-close (OOR remains an informational alert only).

## Config deltas from Meridian

| Key | Meridian | Sirius |
|-----|----------|--------|
| `maxTop10HolderRate` (GMGN) | 0.5 | 0.3 |
| insiders filter | (none) | add, < 10% |
| `indicators.enabled` | false | true |
| `indicators.intervals` | ["5_MINUTE"] | ["15_MINUTE"] |
| `indicators.entryPreset` | supertrend_break | supertrend_break |
| `indicators.exitPreset` | (unused) | ta_exit |
| `rsiOverbought` | 80 | 90 |
| `rsiLength` | 2 | 2 |
| `stopLossPct` / `takeProfitPct` / trailing | −15 / 5 / on | disabled |
| new: `dumpCandlePct` / `dumpWindowPct` / `dumpAlertPnlPct` | — | −15 / −25 / −12 |

## Accepted risks

- **No backstop stop-loss.** If a token dumps and never recovers to RSI(2)>90 / BB-upper, the TA exit
  never fires and the position bleeds. Mitigation is the **dump alert** + operator's manual oversight,
  not an automated stop. Operator accepted this explicitly.
- **1M 24h token volume** (Part 1) — needs a real data source; Meridian's `minVolume` is *pool*
  volume, not token 24h volume. To be resolved in the implementation plan (GMGN field vs. candidate
  payload field).

## Out of scope (v1)

- Auto-deploy / auto-entry (entry stays manual by design).
- Backtesting harness.
- MACD via relay server changes (computed client-side instead).
