import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const WALLETS_PATH = repoPath("smart-wallets.json");

function loadWallets() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
  } catch {
    return { wallets: [] };
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
