import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFetchError } from "../telegram.js";

test("error without a cause keeps its message", () => {
  assert.equal(describeFetchError(new Error("boom"), null), "boom");
});

test("undici 'fetch failed' surfaces the cause code and message", () => {
  const e = new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  assert.equal(describeFetchError(e, null), "fetch failed (ECONNRESET: read ECONNRESET)");
});

test("AggregateError cause lists every attempt's code", () => {
  const agg = new AggregateError([
    Object.assign(new Error("connect ETIMEDOUT 149.154.166.110:443"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("connect ENETUNREACH 2001:67c:4e8:f004::9:443"), { code: "ENETUNREACH" }),
  ], "");
  agg.code = "ETIMEDOUT";
  const e = new TypeError("fetch failed", { cause: agg });
  assert.equal(describeFetchError(e, null), "fetch failed (ETIMEDOUT [ETIMEDOUT, ENETUNREACH])");
});

test("bot token is scrubbed from the description", () => {
  const e = new TypeError("fetch failed", { cause: new Error("bad url https://api.telegram.org/bot123:SECRET/getMe") });
  assert.equal(describeFetchError(e, "123:SECRET"), "fetch failed (bad url https://api.telegram.org/bot***/getMe)");
});
