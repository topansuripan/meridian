import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.screening has pump-guard defaults", () => {
  const s = config.screening;
  assert.equal(s.maxPump5mPct, 20);
  assert.equal(s.maxPump15mPct, 30);
  assert.equal(s.pumpLookbackHours, 2);
});
