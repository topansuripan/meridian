/**
 * Tests for resolvePoolDetail — relay-primary pool detail with a direct-source
 * fallback when the relay 404s (pool rotated out of its discovery set).
 * Run: node --test test-pool-detail-resolver.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePoolDetail } from "./pool-detail-resolver.js";

const POOL = { pool_address: "sz2UJhf8", tvl: 100000, volatility: 1.5 };
const FALLBACK_POOL = { pool_address: "sz2UJhf8", tvl: 99000, volatility: 1.4, _source: "direct" };

test("returns the relay pool on 200 and never calls the fallback", async () => {
  let fallbackCalled = false;
  const pool = await resolvePoolDetail({
    primary: async () => ({ status: 200, pool: POOL }),
    fallback: async () => { fallbackCalled = true; return FALLBACK_POOL; },
  });
  assert.equal(pool, POOL);
  assert.equal(fallbackCalled, false);
});

test("falls back to the direct source when the relay 404s", async () => {
  const pool = await resolvePoolDetail({
    primary: async () => ({ status: 404, statusText: "Not Found", pool: null }),
    fallback: async () => FALLBACK_POOL,
  });
  assert.equal(pool, FALLBACK_POOL);
});

test("falls back when the relay returns 200 but an empty body", async () => {
  const pool = await resolvePoolDetail({
    primary: async () => ({ status: 200, pool: null }),
    fallback: async () => FALLBACK_POOL,
  });
  assert.equal(pool, FALLBACK_POOL);
});

test("propagates non-404 relay errors WITHOUT calling the fallback", async () => {
  let fallbackCalled = false;
  await assert.rejects(
    () => resolvePoolDetail({
      primary: async () => ({ status: 500, statusText: "Server Error", pool: null }),
      fallback: async () => { fallbackCalled = true; return FALLBACK_POOL; },
    }),
    /Pool detail API error: 500/,
  );
  assert.equal(fallbackCalled, false);
});

test("returns null when both relay 404 and fallback find nothing", async () => {
  const pool = await resolvePoolDetail({
    primary: async () => ({ status: 404, pool: null }),
    fallback: async () => null,
  });
  assert.equal(pool, null);
});
