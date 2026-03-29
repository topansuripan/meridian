import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const OPENING_TTL_MS = 60 * 1000;
const OVERVIEW_TTL_MS = 5 * 60 * 1000;

const openingCache = new Map();
const overviewCache = new Map();

export function hasLpAgentKey() {
  return !!process.env.LPAGENT_API_KEY;
}

export function getConfiguredOwnerAddress() {
  if (!process.env.WALLET_PRIVATE_KEY) return null;
  try {
    return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
  } catch {
    return null;
  }
}

async function lpagentGet(path, params = {}) {
  if (!hasLpAgentKey()) throw new Error("LPAGENT_API_KEY not set");
  const url = new URL(`${LPAGENT_API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.LPAGENT_API_KEY },
  });
  if (!res.ok) throw new Error(`LPAgent API error: ${res.status}`);
  return res.json();
}

function asArray(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function positionKey(row) {
  return row?.position || row?.tokenId || row?.id || null;
}

export async function getOpeningPositions({ owner = null, force = false } = {}) {
  const wallet = owner || getConfiguredOwnerAddress();
  if (!wallet || !hasLpAgentKey()) return { owner: wallet, count: 0, data: [] };

  const cached = openingCache.get(wallet);
  if (!force && cached && Date.now() - cached.at < OPENING_TTL_MS) {
    return cached.value;
  }

  const payload = await lpagentGet("/lp-positions/opening", { owner: wallet });
  const value = {
    owner: wallet,
    count: payload?.count ?? asArray(payload).length,
    data: asArray(payload),
  };
  openingCache.set(wallet, { at: Date.now(), value });
  return value;
}

export async function getOpeningPositionMap({ owner = null, force = false } = {}) {
  const opening = await getOpeningPositions({ owner, force });
  const map = {};
  for (const row of opening.data || []) {
    const key = positionKey(row);
    if (key) map[key] = row;
  }
  return map;
}

export async function getHistoricalPositions({ owner = null, fromDate = null, toDate = null, page = 1, limit = 100 } = {}) {
  const wallet = owner || getConfiguredOwnerAddress();
  if (!wallet || !hasLpAgentKey()) return { owner: wallet, data: [] };

  const payload = await lpagentGet("/lp-positions/historical", {
    owner: wallet,
    from_date: fromDate,
    to_date: toDate,
    page,
    limit,
  });

  return {
    owner: wallet,
    data: asArray(payload),
  };
}

export async function getOverview({ owner = null, protocol = "meteora", force = false } = {}) {
  const wallet = owner || getConfiguredOwnerAddress();
  if (!wallet || !hasLpAgentKey()) return null;

  const cacheKey = `${wallet}:${protocol}`;
  const cached = overviewCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < OVERVIEW_TTL_MS) {
    return cached.value;
  }

  const payload = await lpagentGet("/lp-positions/overview", { owner: wallet, protocol });
  const value = payload?.data || null;
  overviewCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function getPositionDetail({ position }) {
  if (!position || !hasLpAgentKey()) return null;
  const payload = await lpagentGet("/lp-positions/position", { position });
  return payload?.data || null;
}
