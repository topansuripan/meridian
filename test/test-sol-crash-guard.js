import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.solCrashGuard has sane defaults", () => {
  const c = config.solCrashGuard;
  assert.ok(c, "solCrashGuard section exists");
  assert.equal(c.enabled, true);
  assert.equal(c.drop1hPct, 3);
  assert.equal(c.drawdown6hPct, 5);
  assert.equal(c.cooldownHours, 6);
  assert.equal(c.reentryRequiresStable, true);
  assert.equal(c.scope, "normal");
  assert.equal(typeof c.keepGasReserveSol, "number");
  assert.equal(c.backfillOnStart, true);
});
