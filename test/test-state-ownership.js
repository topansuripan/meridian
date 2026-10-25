import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

// state.js writes to <its own dir>/state.json, so load a copy from a sandbox dir.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-state-"));
const STATE = path.join(SANDBOX, "state.json");
let state;

before(async () => {
  for (const f of ["state.js", "logger.js", "fast-drop-guard.js", "repo-root.js"]) {
    fs.copyFileSync(path.join(REPO, f), path.join(SANDBOX, f));
  }
  fs.writeFileSync(path.join(SANDBOX, "package.json"), JSON.stringify({ type: "module" }));
  state = await import(pathToFileURL(path.join(SANDBOX, "state.js")).href);
});

const write = (obj) => fs.writeFileSync(STATE, typeof obj === "string" ? obj : JSON.stringify(obj));
const track = (position) => state.trackPosition({ position, pool: "POOL", pool_name: "X-SOL", strategy: "bid_ask", amount_sol: 1 });

test("tracked set: missing file is empty, a valid file lists every recorded position", () => {
  fs.rmSync(STATE, { force: true });
  assert.equal(state.getTrackedPositionSet(STATE).size, 0);
  write({ positions: { AAA: { closed: false }, BBB: { closed: true } } });
  assert.deepEqual([...state.getTrackedPositionSet(STATE)].sort(), ["AAA", "BBB"]);
});

test("tracked set: an unparseable file reports null (every position counts as the bot's)", () => {
  write("{ truncated");
  assert.equal(state.getTrackedPositionSet(STATE), null);
});

test("tracked set: picks up a new record written by trackPosition", () => {
  write({ positions: { AAA: {} } });
  assert.ok(!state.getTrackedPositionSet(STATE).has("NEW1"));
  track("NEW1");
  assert.ok(state.getTrackedPositionSet(STATE).has("NEW1"));
  assert.ok(state.getTrackedPositionSet(STATE).has("AAA"));
  assert.ok(!fs.readdirSync(SANDBOX).some((f) => f.endsWith(".tmp")), "temp file renamed into place");
});

test("save: a corrupt state.json is never overwritten, and saves resume once it parses", () => {
  write("{ truncated");
  track("NEW2");
  assert.equal(fs.readFileSync(STATE, "utf8"), "{ truncated");
  assert.ok(fs.readdirSync(SANDBOX).some((f) => f.startsWith("state.json.corrupt-")), "backup copy written");
  assert.equal(state.isStateWritable(), false, "deploys must stop while records can't be saved");

  write({ positions: { AAA: {} } });
  track("NEW3");
  assert.equal(state.isStateWritable(), true);
  const saved = JSON.parse(fs.readFileSync(STATE, "utf8"));
  assert.deepEqual(Object.keys(saved.positions).sort(), ["AAA", "NEW3"]);
});
