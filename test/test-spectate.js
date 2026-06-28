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
