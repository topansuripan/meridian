import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { config, setSpectateMode } from "../config.js";

test("config.spectateMode defaults to false", () => {
  assert.equal(typeof config.spectateMode, "boolean");
});

test("setSpectateMode flips the live flag and persists, preserving other keys", () => {
  const tmp = "./test/.tmp-user-config.json";
  fs.writeFileSync(tmp, JSON.stringify({ maxPositions: 2, foo: "bar" }, null, 2));
  setSpectateMode(true, tmp);
  assert.equal(config.spectateMode, true);
  const written = JSON.parse(fs.readFileSync(tmp, "utf8"));
  assert.equal(written.spectateMode, true);
  assert.equal(written.maxPositions, 2, "preserves existing keys");
  assert.equal(written.foo, "bar");
  setSpectateMode(false, tmp);
  assert.equal(config.spectateMode, false);
  assert.equal(JSON.parse(fs.readFileSync(tmp, "utf8")).spectateMode, false);
  fs.unlinkSync(tmp);
});

import { spectateWouldBlock, executeTool } from "../tools/executor.js";

test("spectateWouldBlock: true only for write tools when spectating", () => {
  config.spectateMode = true;
  for (const t of ["deploy_position", "close_position", "claim_fees", "swap_token"]) {
    assert.equal(spectateWouldBlock(t), true, `${t} should block`);
  }
  assert.equal(spectateWouldBlock("get_position_pnl"), false, "read tool not blocked");
  config.spectateMode = false;
  assert.equal(spectateWouldBlock("close_position"), false, "off → not blocked");
});

test("executeTool returns a blocked result for write tools while spectating (no execution)", async () => {
  config.spectateMode = true;
  for (const t of ["deploy_position", "close_position", "claim_fees", "swap_token"]) {
    const r = await executeTool(t, { position_address: "x", pool_address: "y" });
    assert.equal(r.blocked, true, `${t} blocked`);
    assert.match(r.reason, /spectate/i);
  }
  config.spectateMode = false;
});
