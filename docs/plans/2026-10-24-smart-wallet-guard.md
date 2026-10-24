# Smart-Wallet Presence Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Block every normal meridian deploy unless ≥`smartWalletMinCount` tracked LP smart wallets already hold an open Meteora DLMM position in any pool of the candidate's base token.

**Architecture:** A dependency-injected presence checker in `smart-wallets.js` (per-wallet position cache 5 min, pool→mint cache forever, fail-closed with rate-limited Telegram alerts), wrapped by `evaluateSmartWalletGuard` which applies the config switch and degen exemption. Three call sites: the hard gate in `tools/executor.js` `runSafetyChecks`, the screening candidate pre-filter in `index.js`, and the opportunity poller in `index.js`. Ships disabled.

**Tech Stack:** Node 22 ESM, `@solana/web3.js` (`getProgramAccounts`, `getMultipleAccountsInfo`), `node:test` + `node:assert/strict`.

**Design:** `docs/plans/2026-10-24-smart-wallet-guard-design.md` — read it first.

**Repo / branch:** `D:/aiproject/meridian`, branch `feature/smart-wallet-guard` (off `origin/feature/degen-mode` @ f57894d). The deploy branch is `feature/degen-mode`; NEVER push to the `yunus` or `upstream` remotes.

**Conventions you must follow:**
- `docs/` is gitignored but plan docs are tracked → `git add -f docs/plans/...`.
- Stage files by explicit path. Never `git commit -a`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CnFXHhRpToW95LRhJz9Fny
  ```
- Test runner: `node --test test/<file>.js`. Syntax check of the whole repo: `npm test` (runs `node --check` on every file; uses `find`, so run it from Git Bash).
- Line numbers below are approximate — anchor on the quoted code, not the number.

---

### Task 1: Config section + runtime-update keys

**Files:**
- Modify: `config.js` (after the `solCrashGuard: { ... },` block, ~line 120)
- Modify: `tools/executor.js` (`normalizeConfigValue` booleanKeys ~line 546; `CONFIG_MAP` ~line 685)
- Create: `test/test-smart-wallet-guard.js`

**Step 1: Write the failing test**

Create `test/test-smart-wallet-guard.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";

test("config.smartWalletGuard defaults to off with minCount 1", () => {
  assert.equal(config.smartWalletGuard.enabled, false);
  assert.equal(config.smartWalletGuard.minCount, 1);
});
```

**Step 2: Run it — expect FAIL**

Run: `node --test test/test-smart-wallet-guard.js`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'enabled')`

**Step 3: Add the config section**

In `config.js`, directly after the closing `},` of `solCrashGuard`:

```js
  // ─── Smart-Wallet Presence Guard ─────────
  // Hard deploy gate: require tracked LP smart wallets to already be LPing the token.
  // Ships OFF — with an empty smart-wallets.json it would block every deploy.
  // See docs/plans/2026-10-24-smart-wallet-guard-design.md
  smartWalletGuard: {
    enabled:  u.smartWalletGuardEnabled ?? false,
    minCount: Number(u.smartWalletMinCount ?? 1),
  },
```

In `tools/executor.js` `normalizeConfigValue`, add `"smartWalletGuardEnabled",` to the `booleanKeys` set (after `"autoLearnTopLps",`).

In `tools/executor.js` `CONFIG_MAP`, after the line `opportunitySmartWalletBonus: ["opportunity", "smartWalletScoreBonus"],` add:

```js
      // smart-wallet presence guard
      smartWalletGuardEnabled: ["smartWalletGuard", "enabled"],
      smartWalletMinCount: ["smartWalletGuard", "minCount"],
```

**Step 4: Run test — expect PASS**

Run: `node --test test/test-smart-wallet-guard.js` → `# pass 1`
Run: `node --check config.js && node --check tools/executor.js` → no output

**Step 5: Commit**

```bash
git add config.js tools/executor.js test/test-smart-wallet-guard.js
git commit -m "feat(smart-wallets): add smartWalletGuard config (off by default)"
```

---

### Task 2: Presence checker — core matching

**Files:**
- Modify: `smart-wallets.js` (append after `checkSmartWalletsOnPool`)
- Test: `test/test-smart-wallet-guard.js`

**Step 1: Write the failing tests**

Append to `test/test-smart-wallet-guard.js` (update the import line at the top to also import from `../smart-wallets.js`):

```js
import { createPresenceChecker } from "../smart-wallets.js";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenMint1111111111111111111111111111111111";
const OTHER = "OtherMint1111111111111111111111111111111111";
const W1 = { name: "alpha", address: "Wallet1111111111111111111111111111111111111", type: "lp" };
const W2 = { name: "beta", address: "Wallet2222222222222222222222222222222222222", type: "lp" };
const HOLDER = { name: "hodl", address: "Wallet3333333333333333333333333333333333333", type: "holder" };

// P_TOKEN = TOKEN/SOL, P_OTHER = OTHER/SOL, P_FLIP = SOL/TOKEN (token on the Y side)
const POOL_MINTS = { P_TOKEN: [TOKEN, SOL], P_OTHER: [OTHER, SOL], P_FLIP: [SOL, TOKEN] };

function harness({ wallets = [W1, W2], positions = {}, failing = new Set(), mintFails = false, notifyThrows = false } = {}) {
  let t = 1_000_000;
  const calls = { positions: [], mints: [], alerts: [] };
  const state = { failing, mintFails };
  const checker = createPresenceChecker({
    listWallets: () => wallets,
    fetchPositionPools: async (addr) => {
      calls.positions.push(addr);
      if (state.failing.has(addr)) throw new Error("429 Too Many Requests");
      return positions[addr] || [];
    },
    fetchPoolMints: async (pools) => {
      calls.mints.push([...pools]);
      if (state.mintFails) throw new Error("rpc down");
      return new Map(pools.filter((p) => POOL_MINTS[p]).map((p) => [p, POOL_MINTS[p]]));
    },
    notify: async (text) => {
      if (notifyThrows) throw new Error("telegram down");
      calls.alerts.push(text);
    },
    now: () => t,
    sleep: async () => {},
  });
  return { checker, calls, state, wallets, advance: (ms) => { t += ms; } };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

test("passes when one tracked wallet LPs any pool of the token", async () => {
  const { checker } = harness({ positions: { [W1.address]: [P("P_TOKEN")] } });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, true);
  assert.equal(r.kind, "ok");
  assert.equal(r.count, 1);
  assert.equal(r.matched[0].name, "alpha");
});

test("token on the Y side of a pool counts as presence", async () => {
  const { checker } = harness({ positions: { [W2.address]: [P("P_FLIP")] } });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, true);
});

test("verified absence blocks as 'none' without an alert", async () => {
  const { checker, calls } = harness({ positions: { [W1.address]: [P("P_OTHER")] } });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, false);
  assert.equal(r.kind, "none");
  assert.equal(calls.alerts.length, 0);
});

test("minCount 2 needs two distinct wallets", async () => {
  const one = harness({ positions: { [W1.address]: [P("P_TOKEN")] } });
  assert.equal((await one.checker.check({ baseMint: TOKEN, minCount: 2 })).kind, "none");
  const two = harness({ positions: { [W1.address]: [P("P_TOKEN")], [W2.address]: [P("P_FLIP")] } });
  const r = await two.checker.check({ baseMint: TOKEN, minCount: 2 });
  assert.equal(r.pass, true);
  assert.equal(r.count, 2);
});

test("holder-type wallets are ignored (list counts as empty)", async () => {
  const { checker } = harness({ wallets: [HOLDER], positions: { [HOLDER.address]: [P("P_TOKEN")] } });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, false);
  assert.equal(r.kind, "empty");
});

test("missing or quote base mint blocks as 'no-mint'", async () => {
  const { checker } = harness({ positions: { [W1.address]: [P("P_TOKEN")] } });
  assert.equal((await checker.check({ baseMint: undefined })).kind, "no-mint");
  assert.equal((await checker.check({ baseMint: SOL })).kind, "no-mint");
});

// pool ids are plain strings in the fakes
function P(id) { return id; }
```

**Step 2: Run — expect FAIL**

Run: `node --test test/test-smart-wallet-guard.js`
Expected: FAIL — `SyntaxError: The requested module '../smart-wallets.js' does not provide an export named 'createPresenceChecker'`

**Step 3: Implement**

At the top of `smart-wallets.js` nothing changes yet. Append to the end of `smart-wallets.js`:

```js
// ─── Presence guard ─────────────────────────────────────────────
// Hard deploy gate: require ≥minCount tracked LP wallets to hold an open DLMM
// position in ANY pool of the candidate's base token. Fails closed.
// See docs/plans/2026-10-24-smart-wallet-guard-design.md

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",  // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
]);
const POSITIONS_TTL_MS = 5 * 60_000;    // fresh per-wallet lookup
const STALE_OK_MS = 30 * 60_000;        // a cached lookup this old still counts when RPC fails
const ALERT_INTERVAL_MS = 6 * 3600_000; // one Telegram alert per failure kind per 6h
const LOOKUP_GAP_MS = 250;              // between uncached wallet lookups (public RPC rate limit)

const walletLabel = (w) => w.name || `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;

export function createPresenceChecker({
  listWallets,
  fetchPositionPools,
  fetchPoolMints,
  notify = async () => {},
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const posCache = new Map();    // wallet address -> { pools, fetchedAt }
  const mintCache = new Map();   // pool address -> [mintX, mintY] ([] if the account is missing)
  const lastAlertAt = new Map(); // alert kind -> ms

  const isFresh = (address) => {
    const c = posCache.get(address);
    return !!c && now() - c.fetchedAt < POSITIONS_TTL_MS;
  };

  async function poolsFor(wallet) {
    const cached = posCache.get(wallet.address);
    if (isFresh(wallet.address)) return cached.pools;
    try {
      const pools = await fetchPositionPools(wallet.address);
      posCache.set(wallet.address, { pools, fetchedAt: now() });
      return pools;
    } catch (e) {
      if (cached && now() - cached.fetchedAt <= STALE_OK_MS) {
        log("smart_wallets", `Lookup failed for ${walletLabel(wallet)} (${e.message}) — using ${Math.round((now() - cached.fetchedAt) / 60_000)}m-old cache`);
        return cached.pools;
      }
      log("smart_wallets", `Lookup failed for ${walletLabel(wallet)}: ${e.message}`);
      return null;
    }
  }

  async function mintsFor(pools) {
    const missing = pools.filter((p) => !mintCache.has(p));
    if (missing.length) {
      const resolved = await fetchPoolMints(missing);
      for (const p of missing) mintCache.set(p, resolved.get(p) || []);
    }
    return new Set(pools.flatMap((p) => mintCache.get(p)));
  }

  async function maybeAlert(kind, text) {
    const last = lastAlertAt.get(kind);
    if (last != null && now() - last < ALERT_INTERVAL_MS) return;
    lastAlertAt.set(kind, now());
    try { await notify(text); } catch { /* alerts are best-effort */ }
  }

  async function check({ baseMint, minCount = 1, alert = true, stopAtMinCount = true } = {}) {
    const required = Math.max(1, Number(minCount) || 1);
    const empty = { required, count: 0, matched: [], failed: [] };
    if (!baseMint || QUOTE_MINTS.has(baseMint)) {
      return { ...empty, pass: false, kind: "no-mint", reason: `Smart-wallet guard: base mint ${baseMint ? "is a quote token" : "unknown"} — cannot verify presence` };
    }
    const wallets = listWallets().filter((w) => !w.type || w.type === "lp");
    if (wallets.length === 0) {
      const reason = "Smart-wallet guard: no LP smart wallets tracked — every deploy is blocked until you add some (or set smartWalletGuardEnabled false)";
      if (alert) await maybeAlert("empty", `⚠️ ${reason}`);
      return { ...empty, pass: false, kind: "empty", reason };
    }

    const matched = [];
    const failed = [];
    let fetchedThisCall = false;
    for (const w of wallets) {
      if (stopAtMinCount && matched.length >= required) break;
      const needsFetch = !isFresh(w.address);
      if (needsFetch && fetchedThisCall) await sleep(LOOKUP_GAP_MS);
      if (needsFetch) fetchedThisCall = true;
      const pools = await poolsFor(w);
      if (!pools) { failed.push(w); continue; }
      let mints;
      try {
        mints = await mintsFor(pools);
      } catch (e) {
        log("smart_wallets", `Pool mint lookup failed for ${walletLabel(w)}: ${e.message}`);
        failed.push(w);
        continue;
      }
      if (mints.has(baseMint)) matched.push({ name: w.name, address: w.address });
    }

    const result = {
      required,
      count: matched.length,
      matched,
      failed: failed.map((w) => ({ name: w.name, address: w.address })),
    };
    const names = matched.map(walletLabel).join(", ");
    if (matched.length >= required) {
      return { ...result, pass: true, kind: "ok", reason: `Smart-wallet guard: ${matched.length}/${required} present (${names})` };
    }
    if (failed.length > 0) {
      const reason = `Smart-wallet guard: only ${matched.length}/${required} confirmed and ${failed.length}/${wallets.length} wallet lookup(s) failed — presence unverified`;
      if (alert) await maybeAlert("unverified", `⚠️ ${reason} (${failed.map(walletLabel).join(", ")}). Deploys stay blocked while lookups fail.`);
      return { ...result, pass: false, kind: "unverified", reason };
    }
    return { ...result, pass: false, kind: "none", reason: `Smart-wallet guard: ${matched.length}/${required} tracked LP wallets in this token${names ? ` (${names})` : ""}` };
  }

  return { check };
}
```

**Step 4: Run — expect PASS**

Run: `node --test test/test-smart-wallet-guard.js` → `# pass 7`, `# fail 0`

**Step 5: Commit**

```bash
git add smart-wallets.js test/test-smart-wallet-guard.js
git commit -m "feat(smart-wallets): add token-level presence checker"
```

---

### Task 3: Failure handling, caching, early stop

The code from Task 2 already implements these; this task locks the behaviour with tests. If any test fails, fix `createPresenceChecker`, not the test.

**Files:**
- Test: `test/test-smart-wallet-guard.js`

**Step 1: Write the tests**

Append:

```js
test("a failed lookup does not block when presence is already proven", async () => {
  const { checker } = harness({
    positions: { [W2.address]: ["P_TOKEN"] },
    failing: new Set([W1.address]),
  });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, true);
  assert.equal(r.failed[0].name, "alpha");
});

test("failed lookup without enough presence blocks as 'unverified'", async () => {
  const { checker } = harness({
    positions: { [W2.address]: ["P_OTHER"] },
    failing: new Set([W1.address]),
  });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.pass, false);
  assert.equal(r.kind, "unverified");
});

test("pool-mint resolution failure counts as a failed lookup", async () => {
  const { checker } = harness({ positions: { [W1.address]: ["P_TOKEN"] }, mintFails: true });
  const r = await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.equal(r.kind, "unverified");
});

test("per-wallet positions are cached for 5 minutes", async () => {
  const { checker, calls, advance } = harness({
    positions: { [W1.address]: ["P_OTHER"], [W2.address]: ["P_OTHER"] },
  });
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.positions.length, 2);
  advance(4 * MIN);
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.positions.length, 2, "no refetch inside TTL");
  advance(2 * MIN);
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.positions.length, 4, "refetch after TTL");
});

test("stale cache rides out a transient failure for up to 30 minutes", async () => {
  const h = harness({ wallets: [W1], positions: { [W1.address]: ["P_TOKEN"] } });
  assert.equal((await h.checker.check({ baseMint: TOKEN })).pass, true);
  h.state.failing.add(W1.address);
  h.advance(10 * MIN);
  assert.equal((await h.checker.check({ baseMint: TOKEN })).pass, true, "10m-old cache used");
  h.advance(25 * MIN); // cache now 35m old
  assert.equal((await h.checker.check({ baseMint: TOKEN })).kind, "unverified");
});

test("pool mints are resolved once and reused", async () => {
  const { checker, calls } = harness({
    positions: { [W1.address]: ["P_TOKEN", "P_OTHER"], [W2.address]: ["P_TOKEN"] },
  });
  await checker.check({ baseMint: TOKEN, minCount: 1, stopAtMinCount: false });
  assert.equal(calls.mints.length, 1);
  assert.deepEqual(calls.mints[0], ["P_TOKEN", "P_OTHER"]);
});

test("stops fetching wallets once minCount is met", async () => {
  const { checker, calls } = harness({
    positions: { [W1.address]: ["P_TOKEN"], [W2.address]: ["P_TOKEN"] },
  });
  await checker.check({ baseMint: TOKEN, minCount: 1 });
  assert.deepEqual(calls.positions, [W1.address]);
});
```

**Step 2: Run**

Run: `node --test test/test-smart-wallet-guard.js` → `# pass 14`, `# fail 0`

**Step 3: Commit**

```bash
git add test/test-smart-wallet-guard.js
git commit -m "test(smart-wallets): cover guard failure, cache and early-stop behaviour"
```

---

### Task 4: Alert rate limiting

**Files:**
- Test: `test/test-smart-wallet-guard.js`

**Step 1: Write the tests**

Append:

```js
test("empty-list alert fires at most once per 6 hours", async () => {
  const { checker, calls, advance } = harness({ wallets: [] });
  await checker.check({ baseMint: TOKEN });
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.alerts.length, 1);
  advance(6 * HOUR + 1);
  await checker.check({ baseMint: TOKEN });
  assert.equal(calls.alerts.length, 2);
});

test("alert kinds are rate-limited independently", async () => {
  const h = harness({ wallets: [] });
  await h.checker.check({ baseMint: TOKEN }); // empty
  h.wallets.push(W1);
  h.state.failing.add(W1.address);
  await h.checker.check({ baseMint: TOKEN }); // unverified
  assert.equal(h.calls.alerts.length, 2);
  assert.match(h.calls.alerts[0], /no LP smart wallets/);
  assert.match(h.calls.alerts[1], /unverified/);
});

test("alert:false never notifies", async () => {
  const { checker, calls } = harness({ wallets: [] });
  await checker.check({ baseMint: TOKEN, alert: false });
  assert.equal(calls.alerts.length, 0);
});

test("a throwing notifier does not break the check", async () => {
  const { checker } = harness({ wallets: [], notifyThrows: true });
  const r = await checker.check({ baseMint: TOKEN });
  assert.equal(r.kind, "empty");
});
```

**Step 2: Run**

Run: `node --test test/test-smart-wallet-guard.js` → `# pass 18`, `# fail 0`

**Step 3: Commit**

```bash
git add test/test-smart-wallet-guard.js
git commit -m "test(smart-wallets): cover guard alert rate limiting"
```

---

### Task 5: Real RPC fetchers + `evaluateSmartWalletGuard` wrapper

**Files:**
- Modify: `smart-wallets.js` (imports at top; append wrapper + fetchers)
- Test: `test/test-smart-wallet-guard.js`

**Step 1: Write the failing tests**

Append (and add `evaluateSmartWalletGuard` to the `../smart-wallets.js` import):

```js
import { evaluateSmartWalletGuard } from "../smart-wallets.js";

async function withGuardConfig(patch, fn) {
  const saved = { ...config.smartWalletGuard };
  Object.assign(config.smartWalletGuard, patch);
  try { return await fn(); } finally { Object.assign(config.smartWalletGuard, saved); }
}
const explodingChecker = { check: async () => { throw new Error("checker must not run"); } };

test("evaluateSmartWalletGuard: disabled guard skips the check", async () => {
  await withGuardConfig({ enabled: false }, async () => {
    const r = await evaluateSmartWalletGuard({ baseMint: TOKEN }, explodingChecker);
    assert.equal(r.pass, true);
    assert.equal(r.kind, "disabled");
  });
});

test("evaluateSmartWalletGuard: degen deploys are exempt", async () => {
  await withGuardConfig({ enabled: true }, async () => {
    const r = await evaluateSmartWalletGuard({ baseMint: TOKEN, isDegen: true }, explodingChecker);
    assert.equal(r.pass, true);
    assert.equal(r.kind, "degen");
  });
});

test("evaluateSmartWalletGuard: enabled delegates with config minCount", async () => {
  await withGuardConfig({ enabled: true, minCount: 2 }, async () => {
    let seen = null;
    const checker = { check: async (args) => { seen = args; return { pass: false, kind: "none", matched: [] }; } };
    const r = await evaluateSmartWalletGuard({ baseMint: TOKEN }, checker);
    assert.equal(r.kind, "none");
    assert.equal(seen.baseMint, TOKEN);
    assert.equal(seen.minCount, 2);
  });
});
```

**Step 2: Run — expect FAIL**

Run: `node --test test/test-smart-wallet-guard.js`
Expected: FAIL — `does not provide an export named 'evaluateSmartWalletGuard'`

**Step 3: Implement**

At the top of `smart-wallets.js`, after the existing imports, add:

```js
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { sendMessage } from "./telegram.js";
```

Append to the end of `smart-wallets.js`:

```js
// ─── Real fetchers (public RPC_URL) ─────────────────────────────
const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

let _connection = null;
function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

// Pools (lbPair addresses) the owner has open DLMM positions in.
// Position layout: lbPair @8..40, owner @40..72 — same filter as getWalletPositions,
// but sliced to the lbPair only and without the Meteora PnL enrichment.
export async function fetchPositionPools(owner) {
  const accounts = await getConnection().getProgramAccounts(new PublicKey(DLMM_PROGRAM_ID), {
    dataSlice: { offset: 8, length: 32 },
    filters: [{ memcmp: { offset: 40, bytes: owner } }],
  });
  return [...new Set(accounts.map((a) => new PublicKey(a.account.data).toBase58()))];
}

// lbPair -> [tokenXMint, tokenYMint]. LbPair layout: tokenXMint @88..120, tokenYMint @120..152
// (verified on DMXK4u68… and Gc5hVCBy… 2026-10-24). Missing/foreign accounts are omitted.
export async function fetchPoolMints(pools) {
  const out = new Map();
  for (let i = 0; i < pools.length; i += 100) {
    const chunk = pools.slice(i, i + 100);
    const infos = await getConnection().getMultipleAccountsInfo(chunk.map((p) => new PublicKey(p)));
    infos.forEach((info, j) => {
      if (!info || info.owner.toBase58() !== DLMM_PROGRAM_ID || info.data.length < 152) return;
      out.set(chunk[j], [
        new PublicKey(info.data.subarray(88, 120)).toBase58(),
        new PublicKey(info.data.subarray(120, 152)).toBase58(),
      ]);
    });
  }
  return out;
}

let _defaultChecker = null;
function defaultChecker() {
  if (!_defaultChecker) {
    _defaultChecker = createPresenceChecker({
      listWallets: () => loadWallets().wallets,
      fetchPositionPools,
      fetchPoolMints,
      notify: (text) => sendMessage(text),
    });
  }
  return _defaultChecker;
}

// Single entry point for every call site: applies the config switch + degen exemption.
export async function evaluateSmartWalletGuard({ baseMint, isDegen = false } = {}, checker = defaultChecker()) {
  const cfg = config.smartWalletGuard;
  if (!cfg?.enabled) return { pass: true, kind: "disabled", matched: [], reason: "Smart-wallet guard disabled" };
  if (isDegen) return { pass: true, kind: "degen", matched: [], reason: "Smart-wallet guard: degen deploys exempt" };
  return checker.check({ baseMint, minCount: cfg.minCount });
}
```

Note: `defaultChecker()` in the default parameter runs only when no checker is passed, so the tests never touch the RPC.

**Step 4: Run — expect PASS**

Run: `node --test test/test-smart-wallet-guard.js` → `# pass 21`, `# fail 0`
Run: `node --test test/test-sol-crash-guard.js` → still all pass
Run: `node --check smart-wallets.js` → no output. (Never `import('./index.js')` to smoke-test — it starts the live bot loop.)

**Step 5: Commit**

```bash
git add smart-wallets.js test/test-smart-wallet-guard.js
git commit -m "feat(smart-wallets): wire presence checker to RPC and config"
```

---

### Task 6: Hard gate in `runSafetyChecks`

**Files:**
- Modify: `tools/executor.js` (import line ~23; `runSafetyChecks` after the Saturday rule ~line 1440)

**Step 1: Update the import**

Change:
```js
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
```
to:
```js
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool, evaluateSmartWalletGuard } from "../smart-wallets.js";
```

**Step 2: Insert the gate**

Directly after the closing `}` of the `// Saturday rule: ...` block (the one returning `Saturday rule: token ... was already deployed on Friday`), and before `// Check amount limits`, insert:

```js
      // Smart-wallet presence guard (NORMAL only, degen exempt): tracked LP smart wallets
      // must already be LPing this token. Fails closed — see smart-wallets.js.
      try {
        const swGuard = await evaluateSmartWalletGuard({ baseMint, isDegen });
        if (!swGuard.pass) return { pass: false, reason: swGuard.reason };
        if (swGuard.kind === "ok") log("safety_check", swGuard.reason);
      } catch (e) {
        return { pass: false, reason: `Smart-wallet guard error: ${e.message}` };
      }
```

`baseMint` and `isDegen` are already in scope in this `case "deploy_position"` block (verify by reading upward). A block here flows into the existing handler that logs `safety_block`, sends "⛔ Deploy Blocked" to Telegram and sets the pool/token deploy-failure cooldown — no extra notification needed.

**Step 3: Verify**

Run: `node --check tools/executor.js` → no output
Run: `node --test test/test-smart-wallet-guard.js` → all pass

**Step 4: Commit**

```bash
git add tools/executor.js
git commit -m "feat(executor): block normal deploys without smart-wallet presence"
```

---

### Task 7: Screening pre-filter

**Files:**
- Modify: `index.js` (import line ~34; screening candidate loop ~line 890; `passing` filter ~line 910)

**Step 1: Update the import**

Change:
```js
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
```
to:
```js
import { checkSmartWalletsOnPool, evaluateSmartWalletGuard } from "./smart-wallets.js";
```

**Step 2: Use the token-level check in the candidate loop**

In `runScreeningCycle`, replace:

```js
    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
```

with:

```js
    const allCandidates = [];
    // Smart-wallet guard on: use the token-level presence check (same one the executor
    // enforces) so the LLM never picks a pool that will be blocked. Off: legacy soft signal.
    const guardOn = config.smartWalletGuard?.enabled === true;
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        guardOn
          ? evaluateSmartWalletGuard({ baseMint: mint }).then((presence) => ({ in_pool: presence.matched || [], presence }))
          : checkSmartWalletsOnPool({ pool_address: pool.pool }),
```

(The rest of the loop is unchanged — `sw` keeps its `{ in_pool }` shape, so the prompt lines `smart_wallets: N present → CONFIDENCE BOOST (...)` keep working.)

**Step 3: Drop failing candidates — BEFORE the GMGN early return**

Replace:

```js
    const passing = allCandidates.filter(({ pool, ti }) => {
      if (pool.gmgn) return true;
```

with:

```js
    const passing = allCandidates.filter(({ pool, ti, sw }) => {
      // Before the GMGN early-return: the smart-wallet guard applies to every candidate source.
      if (guardOn && !sw?.presence?.pass) {
        const reason = sw?.presence?.reason || "smart-wallet check failed";
        log("screening", `Smart-wallet guard: dropped ${pool.name} — ${reason}`);
        filteredOut.push({ name: pool.name, reason });
        return false;
      }
      if (pool.gmgn) return true;
```

A rejected presence promise leaves `sw` null → dropped (fail closed).

**Step 4: Verify**

Run: `node --check index.js` → no output

**Step 5: Commit**

```bash
git add index.js
git commit -m "feat(screening): pre-filter candidates by smart-wallet presence"
```

---

### Task 8: Opportunity poller

**Files:**
- Modify: `index.js` (opportunity poller loop ~line 1650)

**Step 1: Gate the trigger**

Replace:

```js
        let trigger = null;
        for (const c of candidates) {
          const s = degenScore(c, config.opportunity);
          if (s < floor) break; // sorted desc — nothing below can qualify either
          if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
```

with:

```js
        let trigger = null;
        const guardOn = config.smartWalletGuard?.enabled === true;
        for (const c of candidates) {
          const s = degenScore(c, config.opportunity);
          if (s < floor) break; // sorted desc — nothing below can qualify either
          if (guardOn) {
            // Presence is mandatory; it also earns the borderline bonus. Cached per wallet,
            // so the 45s poll does not add RPC load beyond the 5-min refresh.
            if (s < minScore && bonus <= 0) continue;
            const pres = await evaluateSmartWalletGuard({ baseMint: c.base?.mint }).catch(() => null);
            if (!pres?.pass) continue;
            trigger = { c, s, smart: pres.matched };
            break;
          }
          if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
```

The existing `smartTag` log line already handles `trigger.smart` entries with `name`/`address`.

**Step 2: Verify**

Run: `node --check index.js` → no output

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat(opportunity): require smart-wallet presence when the guard is on"
```

---

### Task 9: CLI check command + docs

**Files:**
- Modify: `cli.js` (SKILL_MD text after the `### meridian wallet-positions` section ~line 151; new `case` after `case "wallet-positions"` ~line 431)
- Modify: `CLAUDE.md` (the `smart-wallets.js` row ~line 108)

**Step 1: Add the help text**

In `cli.js` SKILL_MD, after the `wallet-positions` block (ends with the closing ``\`\`\``` and a blank line), insert:

```
### meridian smart-wallet-check --mint <base_mint> [--wallet <addr>]
Read-only. Checks which tracked LP smart wallets (or one ad-hoc --wallet) hold an open DLMM position in any pool of the token. Never sends alerts; ignores smartWalletGuardEnabled.
\`\`\`
Output: { pass, kind, required, count, matched: [{name, address}], failed: [...], reason }
\`\`\`

```

**Step 2: Add the command**

After the `case "wallet-positions": { ... break; }` block:

```js
  // ── smart-wallet-check ───────────────────────────────────────────
  case "smart-wallet-check": {
    if (!flags.mint) die("Usage: meridian smart-wallet-check --mint <base_mint> [--wallet <addr>]");
    const { createPresenceChecker, fetchPositionPools, fetchPoolMints, listSmartWallets } = await import("./smart-wallets.js");
    const { config } = await import("./config.js");
    const wallets = flags.wallet
      ? [{ name: "adhoc", address: flags.wallet, type: "lp" }]
      : listSmartWallets().wallets;
    const checker = createPresenceChecker({ listWallets: () => wallets, fetchPositionPools, fetchPoolMints });
    out(await checker.check({ baseMint: flags.mint, minCount: config.smartWalletGuard.minCount, alert: false, stopAtMinCount: false }));
    break;
  }
```

**Step 3: Update CLAUDE.md**

Append to the end of the `smart-wallets.js` row's description cell (before the closing `|`):
` **Presence guard:** \`evaluateSmartWalletGuard\` hard-blocks normal deploys unless ≥\`smartWalletMinCount\` LP wallets hold a DLMM position in any pool of the token (off by default, \`smartWalletGuardEnabled\`); see docs/plans/2026-10-24-smart-wallet-guard-design.md.`

**Step 4: Verify everything**

Run (Git Bash): `npm test` → exits 0 (syntax check of every file)
Run: `node --test test/test-smart-wallet-guard.js test/test-sol-crash-guard.js test/test-pump-guard.js test/test-spectate.js` → `# fail 0`
Run: `node cli.js smart-wallet-check` → prints the usage error (proves the case is wired, no RPC call)

**Step 5: Commit**

```bash
git add cli.js CLAUDE.md
git commit -m "feat(cli): add read-only smart-wallet-check command"
```

---

### Task 10: Ship to the VPS (guard OFF) — ASK THE USER FIRST

These steps push to the user's GitHub and restart a live trading bot. **Get explicit confirmation before Step 2 and again before Step 5.** Important: `pm2 restart meridian` re-runs `startCronJobs()`, so a bot that was `/pause`d resumes autonomous cycles. Ask the user whether to re-`/pause` it afterwards.

**Step 1: Code review** — dispatch superpowers:code-reviewer over `origin/feature/degen-mode..feature/smart-wallet-guard`; fix findings before shipping.

**Step 2: Merge + push (after confirmation)**

```bash
git switch feature/degen-mode
git merge --ff-only origin/feature/degen-mode   # local copy is stale (fa466a6)
git merge --no-ff feature/smart-wallet-guard -m "Merge feature/smart-wallet-guard: smart-wallet presence deploy guard"
git push origin feature/degen-mode
```

**Step 3: Update files on the VPS (the running process keeps old code until restart)**

```bash
ssh vps 'cd /root/meridian && git fetch origin && git merge --ff-only origin/feature/degen-mode && git log --oneline -1'
```

If the merge refuses (local VPS changes), STOP and report — do not force.

**Step 4: Read-only live smoke test of the real fetchers**

Find a real LPer + token from an active pool, then check presence and absence:

```bash
ssh vps 'cd /root/meridian && node -e "
import(\"@solana/web3.js\").then(async ({Connection,PublicKey})=>{
  const c=new Connection(process.env.RPC_URL||\"https://api.mainnet-beta.solana.com\");
  const pool=new PublicKey(\"Gc5hVCBydc6k3Z7oc2cQEW4GThFQi2Fqk5HfKABqa2q8\"); // PAID-SOL; swap for any active pool if empty
  const acc=await c.getProgramAccounts(new PublicKey(\"LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo\"),{dataSlice:{offset:40,length:32},filters:[{memcmp:{offset:8,bytes:pool.toBase58()}}]});
  console.log(\"positions\",acc.length, \"owner\", acc[0] && new PublicKey(acc[0].account.data).toBase58());
});"'
```

Then, with `<OWNER>` from above and that pool's base mint `98kfF7rmsg1QDUEoCqNE7g7M1FdrTt92TEp2CLzypump`:

```bash
ssh vps 'cd /root/meridian && node cli.js smart-wallet-check --mint 98kfF7rmsg1QDUEoCqNE7g7M1FdrTt92TEp2CLzypump --wallet <OWNER>'
# expect: "pass": true, "kind": "ok"
ssh vps 'cd /root/meridian && node cli.js smart-wallet-check --mint 6Mix12LiHrQFojaQEnfPUC65Qkwd6X4Y5Qg93oFbordr --wallet <OWNER>'
# expect: "kind": "none" (unless that owner also LPs it)
```

If the pool has 0 positions, pick another active pool from the latest screening log. If the smoke test fails, roll the VPS back with `git reset --hard f57894d` (ff-only merge, nothing else to lose — confirm `git status` is clean of tracked changes first) and stop.

**Step 5: Restart (after confirmation)**

```bash
ssh vps 'cd /root/meridian && pm2 restart meridian --update-env && sleep 20 && pm2 logs meridian --lines 40 --nostream'
```

Check the first lines say `Mode: LIVE` and no import/startup errors. The guard is OFF, so behaviour is unchanged.

**Step 6: Hand over enabling to the user**

The user enables it when ready:
1. Add wallets by chatting with the bot: "add smart wallet `<address>` as `<name>`" (repeat), or `list smart wallets` to confirm.
2. Vet each with `node cli.js smart-wallet-check --mint <a token they LP> --wallet <addr>`.
3. Enable via chat ("set smartWalletGuardEnabled true") — applies live via `update_config` and persists to `user-config.json`. Optional: `smartWalletMinCount`.

---

## Done when

- `node --test test/test-smart-wallet-guard.js` → 21 pass, 0 fail; `npm test` exits 0.
- VPS smoke test shows `ok` for a real LPer and `none` for a token they don't LP.
- Meridian restarted cleanly with the guard OFF; user knows how to add wallets and enable it.
