/**
 * pool-detail-resolver.js — relay-primary pool-detail resolution with a
 * direct-source fallback.
 *
 * The Agent Meridian relay's /discovery/pools/{addr} endpoint only serves pools
 * currently in its discovery set, so it 404s for a valid pool that has rotated
 * out (or is inconsistently cached). A single 404 was hard-blocking deploys and
 * setting a 2h cooldown. This keeps the relay as the primary source (for data
 * consistency with screening) but degrades to the direct Meteora universal
 * endpoint on a 404 / empty body before giving up. Non-404 relay errors still
 * propagate — those are genuine failures, not a missing pool.
 *
 * `primary` returns `{ status, statusText?, pool }`; `fallback` returns a pool
 * object or null (or throws). I/O is injected so this is unit-testable.
 */
export async function resolvePoolDetail({ primary, fallback }) {
  const res = await primary();
  const status = res?.status;

  if (status != null && status !== 200 && status !== 404) {
    throw new Error(`Pool detail API error: ${status}${res?.statusText ? ` ${res.statusText}` : ""}`);
  }

  const pool = status === 404 ? null : (res?.pool ?? null);
  if (pool) return pool;

  // 404 or empty 200 from the relay — try the direct source.
  return fallback();
}
