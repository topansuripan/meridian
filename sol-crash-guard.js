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
