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
