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

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

const HOUR = 3600_000;
const MIN_HISTORY_MS = 55 * 60_000; // need ~1h before the 1h test is valid
const DRAWDOWN_WINDOW_MS = 6 * HOUR; // lookback window for the 6h-high drawdown
const PRICE_MATCH_TOLERANCE_MS = 30 * 60_000; // max |t - target| for a sample to count as "at" target

/**
 * Price at the sample closest to targetMs, or null if the closest sample is
 * more than PRICE_MATCH_TOLERANCE_MS away. The tolerance prevents a
 * multi-hour gap (CoinGecko backfill, cron outage) from being reported as a
 * "1h" move — if nothing landed near targetMs, there is no honest reading.
 */
function priceAround(priceHistory, targetMs) {
  let best = null, bestDist = Infinity;
  for (const [ms, price] of priceHistory) {
    const dist = Math.abs(ms - targetMs);
    if (dist < bestDist) { bestDist = dist; best = price; }
  }
  if (bestDist > PRICE_MATCH_TOLERANCE_MS) return null;
  return best;
}

/**
 * @param {Array<[number, number]>} priceHistory  oldest-first [ms, price]
 * @param {number} now  epoch ms
 * @returns {{ drop1h:number, drawdown6h:number, hasEnoughHistory:boolean, priceNow:number|null }}
 *          drop1h / drawdown6h are signed percentages (negative = falling)
 */
export function computeSolMetrics(priceHistory, now = Date.now()) {
  const pts = (priceHistory || []).filter(p => Array.isArray(p) && Number.isFinite(p[1]) && p[1] > 0);
  if (pts.length < 2) {
    return { drop1h: 0, drawdown6h: 0, hasEnoughHistory: false, priceNow: pts[0]?.[1] ?? null };
  }
  const priceNow = pts[pts.length - 1][1];
  const oldest = pts[0][0];
  const hasEnoughHistory = (now - oldest) >= MIN_HISTORY_MS;

  const price1hAgo = priceAround(pts, now - HOUR);
  const drop1h = price1hAgo != null ? (priceNow / price1hAgo - 1) * 100 : 0;

  const window6h = pts.filter(([ms]) => ms >= now - DRAWDOWN_WINDOW_MS);
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

const DEFAULT_MAX_AGE_MS = 7 * HOUR;

/** Append a sample, drop anything older than maxAgeMs, keep oldest-first. Pure. */
export function pushPrice(priceHistory, price, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!Number.isFinite(price) || price <= 0) return priceHistory;
  const next = [...priceHistory, [now, price]]
    .filter(([ms]) => ms >= now - maxAgeMs)
    .sort((a, b) => a[0] - b[0]);
  return next;
}

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
      parkComplete: false,
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

/**
 * Trip the breaker on a confirmed dump: close all normal positions, park freed
 * SOL into USDC, and start the cooldown.
 *
 * `usdcParked` is measured as the wallet's USDC balance DELTA across the whole
 * trip (before close → after the breaker's own swap). This captures BOTH any
 * executor auto-park-on-close AND the breaker's own SOL->USDC swap, while
 * excluding any pre-existing operator USDC baseline. It does NOT rely on the
 * swap dep's returned `usdcOut` (which may be ~0 when the executor already
 * parked the freed SOL on close).
 *
 * Dep contract:
 *   getNormalOpenPositions()     -> [{ position, pool_name }]
 *   closePosition({ position_address, reason }) -> any  (may auto-park to USDC)
 *   getUsdcBalance()             -> number  (current wallet USDC)
 *   swapSolToUsdc()              -> any     (best-effort park; return value ignored)
 *   notify(text)                 -> void
 */
export async function maybeTrip(state, { now = Date.now(), cfg, deps }) {
  if (!cfg.enabled || state.breaker.active) return state;
  const metrics = computeSolMetrics(state.priceHistory, now);
  const { dumping, reason } = isDumping(metrics, cfg);
  if (!dumping) return state;

  log("sol_guard", `TRIP: ${reason}. Closing normal positions.`);
  const usdcBefore = Number(await deps.getUsdcBalance().catch(() => 0)) || 0;

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

  let parkComplete = true;
  try {
    await deps.swapSolToUsdc();
  } catch (e) {
    parkComplete = false;
    log("sol_guard_warn", `SOL->USDC swap failed: ${e.message} (will retry next cycle)`);
  }

  const usdcAfter = Number(await deps.getUsdcBalance().catch(() => usdcBefore)) || usdcBefore;
  const usdcParked = Math.max(0, usdcAfter - usdcBefore);

  state.breaker = {
    active: true,
    trippedAt: now,
    cooldownUntil: now + cfg.cooldownHours * HOUR,
    reason,
    solAtTrip: metrics.priceNow,
    closedPositions: closed,
    usdcParked,
    parkComplete,
  };

  await deps.notify(
    `🛑 SOL-crash breaker TRIPPED — ${reason}. ` +
    `Closed ${closed.length}/${positions.length} normal positions` +
    (usdcParked != null ? `, parked $${usdcParked.toFixed(2)} USDC` : "") +
    `. Cooldown ${cfg.cooldownHours}h.`
  ).catch(() => {});

  return state;
}

// Keys off `breaker.active` only — that is the single source of truth for
// "are we parked / pausing normal deploys". `now` is accepted for a uniform
// signature with the other state fns but is intentionally unused: re-entry
// (tryReenter) is what clears `active` once the cooldown has elapsed, so once
// active is false there is nothing time-based left to gate on.
export function isCoolingDownState(state, now = Date.now()) {
  return !!(state.breaker.active);
}

/**
 * Re-enter once the cooldown has elapsed and (if required) SOL has stabilized.
 * No-op before the cooldown; stays parked while still dumping; stays active if
 * the re-entry swap throws.
 *
 * Dep contract:
 *   swapUsdcToSol(parkedUsdc) -> { solOut }
 *     where `parkedUsdc` is the USDC amount the breaker parked on trip
 *     (`state.breaker.usdcParked`, null if the trip's SOL->USDC swap had failed).
 *     The dep MUST cap the swap at this amount so operator-held USDC in the same
 *     wallet is never swept back into SOL.
 */
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
    const r = await deps.swapUsdcToSol(state.breaker.usdcParked);
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

let _state = loadState();

export function recordSolPrice(price, now = Date.now()) {
  _state.priceHistory = pushPrice(_state.priceHistory, price, now);
}

export function isCoolingDown(now = Date.now()) {
  if (!config.solCrashGuard.enabled) return false;
  return isCoolingDownState(_state, now);
}

export function getBreakerStatus() {
  return {
    ..._state.breaker,
    closedPositions: [...(_state.breaker.closedPositions || [])],
    samples: _state.priceHistory.length,
  };
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
  if (now - oldest >= DRAWDOWN_WINDOW_MS) return; // already have enough
  try {
    const from = Math.floor((now - 24 * HOUR) / 1000);
    const to = Math.floor(now / 1000);
    const url = `https://api.coingecko.com/api/v3/coins/solana/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const cg = await res.json();
    const fetched = parseCoinGeckoPrices(cg);
    // merge: dedupe by ms (last-write-wins), keep within the max-age window, sort ascending
    const byMs = new Map();
    for (const [ms, price] of [..._state.priceHistory, ...fetched]) {
      if (ms >= now - DEFAULT_MAX_AGE_MS) byMs.set(ms, price);
    }
    const merged = [...byMs.entries()]
      .map(([ms, price]) => [ms, price])
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
 *
 * Swap dep contract:
 *   getUsdcBalance()             -> number      (wallet USDC; used for the
 *     before/after delta that measures how much was parked on trip / re-park)
 *   swapSolToUsdc()              -> any          (trip: park SOL into USDC;
 *     return value is ignored — parked amount is measured via the balance delta)
 *   swapUsdcToSol(parkedUsdc)    -> { solOut }    (re-entry: swap back ONLY the
 *     `parkedUsdc` the breaker recorded on trip — never sweeping unrelated
 *     operator USDC in the same wallet)
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
      // If a prior trip's park did not complete (SOL->USDC swap threw), retry it
      // each cycle BEFORE attempting re-entry — otherwise the trip capital is
      // stranded as SOL and re-entry would have nothing to swap back.
      if (_state.breaker.parkComplete === false) {
        try {
          const usdcBefore = Number(await deps.getUsdcBalance().catch(() => 0)) || 0;
          await deps.swapSolToUsdc();
          const usdcAfter = Number(await deps.getUsdcBalance().catch(() => usdcBefore)) || usdcBefore;
          _state.breaker.usdcParked = Math.max(0, (_state.breaker.usdcParked || 0) + (usdcAfter - usdcBefore));
          _state.breaker.parkComplete = true;
          log("sol_guard", `Re-park succeeded: ${_state.breaker.usdcParked.toFixed(2)} USDC parked total.`);
        } catch (e) {
          log("sol_guard_warn", `Re-park retry failed: ${e.message} (will retry next cycle)`);
        }
      }
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
