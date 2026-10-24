import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { sendMessage } from "./telegram.js";

const WALLETS_PATH = repoPath("smart-wallets.json");

function loadWallets() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
  } catch (e) {
    log("smart_wallets", `smart-wallets.json unreadable: ${e.message}`);
    return { wallets: [], corrupt: true };
  }
}

function saveWallets(data) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(data, null, 2));
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function addSmartWallet({ name, address, category = "alpha", type = "lp" }) {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const data = loadWallets();
  if (data.corrupt) return { success: false, error: "smart-wallets.json is unreadable — fix or delete it by hand first" };
  const existing = data.wallets.find((w) => w.address === address);
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }
  data.wallets.push({ name, address, category, type, addedAt: new Date().toISOString() });
  saveWallets(data);
  log("smart_wallets", `Added wallet: ${name} (${category}, type=${type})`);
  return { success: true, wallet: { name, address, category, type } };
}

export function removeSmartWallet({ address }) {
  const data = loadWallets();
  if (data.corrupt) return { success: false, error: "smart-wallets.json is unreadable — fix or delete it by hand first" };
  const wallet = data.wallets.find((w) => w.address === address);
  if (!wallet) return { success: false, error: "Wallet not found" };
  data.wallets = data.wallets.filter((w) => w.address !== address);
  saveWallets(data);
  log("smart_wallets", `Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export function listSmartWallets() {
  const { wallets } = loadWallets();
  return { total: wallets.length, wallets };
}

// Cache wallet positions for 5 minutes to avoid hammering RPC
const _cache = new Map(); // address -> { positions, fetchedAt }
const CACHE_TTL = 5 * 60 * 1000;

export async function checkSmartWalletsOnPool({ pool_address }) {
  const { wallets: allWallets } = loadWallets();
  // Only check LP-type wallets — holder wallets don't have positions
  const wallets = allWallets.filter((w) => !w.type || w.type === "lp");
  if (wallets.length === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  const { getWalletPositions } = await import("./tools/dlmm.js");

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const cached = _cache.get(wallet.address);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return { wallet, positions: cached.positions };
        }
        const { positions } = await getWalletPositions({ wallet_address: wallet.address });
        _cache.set(wallet.address, { positions: positions || [], fetchedAt: Date.now() });
        return { wallet, positions: positions || [] };
      } catch {
        return { wallet, positions: [] };
      }
    })
  );

  const inPool = results
    .filter((r) => r.positions.some((p) => p.pool === pool_address))
    .map((r) => ({ name: r.wallet.name, category: r.wallet.category, address: r.wallet.address }));

  return {
    pool: pool_address,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    signal: inPool.length > 0
      ? `${inPool.length}/${wallets.length} smart wallet(s) are in this pool: ${inPool.map((w) => w.name).join(", ")} — STRONG signal`
      : `0/${wallets.length} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}

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
const MISS_RETRY_MS = 10 * 60_000;     // re-resolve a pool whose mints came back missing after this long
const MINT_CACHE_MAX = 10_000;          // pool->mints cache size cap (cleared when hit)
const FAIL_BACKOFF_MS = 60_000;         // don't re-hit RPC for a wallet whose lookup just failed
const LOOKUP_GAP_MS = 250;              // between uncached wallet lookups (public RPC rate limit)

const walletLabel = (w) => w.name || `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;

export function createPresenceChecker({
  listWallets,
  fetchPositionPools,
  fetchPoolMints,
  notify = async () => {},
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger = log,
  mintCacheMax = MINT_CACHE_MAX,
}) {
  const posCache = new Map();    // wallet address -> { pools, fetchedAt }
  const mintCache = new Map();   // pool address -> { mints: [mintX, mintY] ([] if the account is missing), at }
  const failedAt = new Map();    // wallet address -> ms of last failed lookup
  const inflight = new Map();    // wallet address -> in-flight lookup promise
  const lastAlertAt = new Map(); // alert kind -> ms

  const isFresh = (address) => {
    const c = posCache.get(address);
    return !!c && now() - c.fetchedAt < POSITIONS_TTL_MS;
  };

  const inBackoff = (address) => {
    const f = failedAt.get(address);
    return f != null && now() - f < FAIL_BACKOFF_MS;
  };

  async function poolsFor(wallet) {
    const cached = posCache.get(wallet.address);
    if (isFresh(wallet.address)) return cached.pools;
    try {
      if (inBackoff(wallet.address)) throw new Error("recent lookup failure — backing off");
      let p = inflight.get(wallet.address);
      if (!p) {
        p = fetchPositionPools(wallet.address).finally(() => inflight.delete(wallet.address));
        inflight.set(wallet.address, p);
      }
      const pools = await p;
      posCache.set(wallet.address, { pools, fetchedAt: now() });
      failedAt.delete(wallet.address);
      return pools;
    } catch (e) {
      // quiet = already in backoff (skipped, or another waiter on the same lookup already recorded the failure)
      const quiet = inBackoff(wallet.address);
      if (!quiet) failedAt.set(wallet.address, now());
      if (cached && now() - cached.fetchedAt <= STALE_OK_MS) {
        if (!quiet) logger("smart_wallets", `Lookup failed for ${walletLabel(wallet)} (${e.message}) — using ${Math.round((now() - cached.fetchedAt) / 60_000)}m-old cache`);
        return cached.pools;
      }
      if (!quiet) logger("smart_wallets", `Lookup failed for ${walletLabel(wallet)}: ${e.message}`);
      return null;
    }
  }

  async function mintsFor(pools) {
    const entries = [];
    const missing = [];
    for (const p of pools) {
      const c = mintCache.get(p);
      if (!c || (c.mints.length === 0 && now() - c.at > MISS_RETRY_MS)) missing.push(p);
      else entries.push(c);
    }
    if (missing.length) {
      const resolved = await fetchPoolMints(missing);
      if (mintCache.size >= mintCacheMax) mintCache.clear();
      for (const p of missing) {
        const e = { mints: resolved.get(p) || [], at: now() };
        mintCache.set(p, e);
        entries.push(e);
      }
    }
    return new Set(entries.flatMap((e) => e.mints));
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
      if (!baseMint && alert) await maybeAlert("no-mint", "⚠️ Smart-wallet guard received a candidate with no base mint — likely a wiring bug; that deploy is blocked.");
      return { ...empty, pass: false, kind: "no-mint", reason: `Smart-wallet guard: base mint ${baseMint ? "is a quote token" : "unknown"} — cannot verify presence` };
    }
    let list;
    try {
      list = listWallets();
      if (!Array.isArray(list)) throw new Error("wallet list is not an array");
    } catch (e) {
      const reason = `Smart-wallet guard: can't read the smart-wallet list (${e.message}) — deploys blocked`;
      if (alert) await maybeAlert("list-error", `⚠️ ${reason}`);
      return { ...empty, pass: false, kind: "list-error", reason };
    }
    const seen = new Set();
    const wallets = list
      .filter((w) => w && typeof w === "object" && typeof w.address === "string")
      .filter((w) => !w.type || w.type === "lp")
      .filter((w) => !seen.has(w.address) && seen.add(w.address));
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
      const needsFetch = !isFresh(w.address) && !inBackoff(w.address);
      if (needsFetch && fetchedThisCall) await sleep(LOOKUP_GAP_MS);
      if (needsFetch) fetchedThisCall = true;
      const pools = await poolsFor(w);
      if (!pools) { failed.push(w); continue; }
      let mints;
      try {
        mints = await mintsFor(pools);
      } catch (e) {
        logger("smart_wallets", `Pool mint lookup failed for ${walletLabel(w)}: ${e.message}`);
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
    return { ...result, pass: false, kind: "none", reason: `Smart-wallet guard: ${matched.length} of ${wallets.length} tracked LP wallets in this token (need ${required})${names ? ` — ${names}` : ""}` };
  }

  return { check };
}

// ─── Real fetchers (public RPC_URL) ─────────────────────────────
// Anchor account discriminators = sha256("account:<Name>")[0..8]; confirmed against the installed
// @meteora-ag/dlmm SDK (positionV2Filter() -> "LgkNAEYaVX3"; getAccountDiscriminator("positionV2"/"lbPair")).
const POSITION_V2_DISCRIMINATOR_B58 = "LgkNAEYaVX3"; // bytes 75b0d4c7f5b485b6
const LB_PAIR_DISCRIMINATOR = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);
const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const RPC_TIMEOUT_MS = 15_000; // lookups are shared between checks — a hung request must not stall the deploy gate

let _connection = null;
function getConnection() {
  // disableRetryOnRateLimit: web3.js otherwise retries 429s for ~7.5s per call; the checker's
  // own backoff + stale cache handle rate limits instead.
  if (!_connection) _connection = new Connection(process.env.RPC_URL, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      // really abort hung requests (withTimeout below is only a backstop)
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
    });
  return _connection;
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${RPC_TIMEOUT_MS / 1000}s`)), RPC_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Pools (lbPair addresses) the owner has open DLMM positions in.
// Position layout: lbPair @8..40, owner @40..72 — same filter as getWalletPositions,
// but sliced to the lbPair only and without the Meteora PnL enrichment.
export async function fetchPositionPools(owner, conn = getConnection()) {
  const ownerB58 = new PublicKey(owner).toBase58(); // throws on malformed input before any RPC call
  const accounts = await withTimeout(
    conn.getProgramAccounts(new PublicKey(DLMM_PROGRAM_ID), {
      dataSlice: { offset: 8, length: 32 },
      filters: [
        { memcmp: { offset: 0, bytes: POSITION_V2_DISCRIMINATOR_B58 } },
        { memcmp: { offset: 40, bytes: ownerB58 } },
      ],
    }),
    "getProgramAccounts",
  );
  return [...new Set(accounts.map((a) => new PublicKey(a.account.data).toBase58()))];
}

// lbPair -> [tokenXMint, tokenYMint]. LbPair layout: tokenXMint @88..120, tokenYMint @120..152
// (verified on DMXK4u68… and Gc5hVCBy… 2026-10-24). Missing/foreign accounts are omitted.
export async function fetchPoolMints(pools, conn = getConnection()) {
  const out = new Map();
  for (let i = 0; i < pools.length; i += 100) {
    const chunk = pools.slice(i, i + 100);
    const infos = await withTimeout(
      conn.getMultipleAccountsInfo(chunk.map((p) => new PublicKey(p))),
      "getMultipleAccountsInfo",
    );
    infos.forEach((info, j) => {
      if (!info || info.owner.toBase58() !== DLMM_PROGRAM_ID || info.data.length < 152) return;
      if (!info.data.subarray(0, 8).equals(LB_PAIR_DISCRIMINATOR)) return;
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
      listWallets: () => {
        const d = loadWallets();
        if (d.corrupt) throw new Error("smart-wallets.json is not valid JSON");
        return d.wallets;
      },
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
