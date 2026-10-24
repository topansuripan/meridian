import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import "../network-defaults.js";

test("happy-eyeballs keeps a slow IPv4 attempt alive instead of dropping it after 250 ms", () => {
  assert.equal(net.getDefaultAutoSelectFamily(), true);
  assert.ok(net.getDefaultAutoSelectFamilyAttemptTimeout() >= 5000);
});
