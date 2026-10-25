import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.screening.reportsToTelegram is a boolean switch", () => {
  assert.equal(typeof config.screening.reportsToTelegram, "boolean");
});
