import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.smartWalletGuard defaults to off with minCount 1", () => {
  assert.equal(config.smartWalletGuard.enabled, false);
  assert.equal(config.smartWalletGuard.minCount, 1);
});
