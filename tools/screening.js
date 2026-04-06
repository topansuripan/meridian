import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { log } from "../logger.js";
import { getHolographicStrategyHint } from "../holographic-memory.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
  timeframe = config.screening.timeframe,
  category = config.screening.category,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
  ].join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const condensed = (data.data || []).map(condensePool);

  // Filter blacklisted base tokens
  const pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) {
    log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens`);
  }

  return {
    total: data.total,
    pools,
  };
}

/**
 * Launchpad-aware organic score adjustment.
 * Some launchpads are higher risk — we penalise their organic score
 * so borderline tokens don't make it through. This is a soft adjustment,
 * not a hard block (blockedLaunchpads in config handles hard blocks).
 */
const LAUNCHPAD_ORGANIC_PENALTY = {
  "pump.fun":       -8,
  "pumpfun":        -8,
  "letsbonk.fun":   -5,
  "letsbonk":       -5,
  "bonk.fun":       -5,
  "moonshot":       -3,
};

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code (with skip reasons), agent picks the best one.
 *
 * @param {{ limit?: number }} opts
 * @returns {{ candidates: Object[], rejected: Object[], total_screened: number, total_eligible: number }}
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const { pools } = await discoverPools({ page_size: 50 });

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const s = config.screening;
  const candidates = [];
  const rejected = [];

  for (const pool of pools) {
    // Already have position here
    if (occupiedPools.has(pool.pool)) {
      rejected.push({ pool: pool.name, pool_address: pool.pool, stage: "ownership", reason: "Already have position in this pool" });
      continue;
    }
    if (occupiedMints.has(pool.base?.mint)) {
      rejected.push({ pool: pool.name, pool_address: pool.pool, stage: "ownership", reason: `Already hold base token ${pool.base?.symbol}` });
      continue;
    }
    if (isPoolOnCooldown(pool.pool)) {
      rejected.push({ pool: pool.name, pool_address: pool.pool, stage: "cooldown", reason: "Pool is on cooldown after repeated weak/OOR outcomes" });
      log("screening", `SKIP ${pool.name}: pool cooldown active`);
      continue;
    }
    if (isBaseMintOnCooldown(pool.base?.mint)) {
      rejected.push({ pool: pool.name, pool_address: pool.pool, stage: "cooldown", reason: `Base token ${pool.base?.symbol} is on cooldown after repeated weak/OOR outcomes` });
      log("screening", `SKIP ${pool.name}: base mint cooldown active`);
      continue;
    }

    const pipeline = evaluatePool(pool, s);
    if (!pipeline.eligible) {
      const reason = pipeline.reasons.join(" | ");
      log("screening", `SKIP ${pool.name}: ${reason}`);
      rejected.push({ pool: pool.name, pool_address: pool.pool, stage: pipeline.stage, reason });
      continue;
    }

    candidates.push({
      ...pool,
      organic_score: pipeline.effectiveOrganic,
      _original_organic: pool.organic_score,
      score: pipeline.score,
      screening_stage: pipeline.stage,
      screening_summary: pipeline.summary,
      strengths: pipeline.strengths,
      warnings: pipeline.warnings,
    });
  }

  for (const candidate of candidates) {
    const hint = getHolographicStrategyHint({
      pool_address: candidate.pool,
      base_mint: candidate.base?.mint,
    });
    if (!hint) continue;

    candidate.score = Math.max(0, Math.min(100, candidate.score + (hint.score_boost || 0)));
    candidate.lp_strategy_hint = hint.strategy;
    candidate.bins_below_hint = hint.bins_below;
    candidate.bins_above_hint = hint.bins_above;
    candidate.holographic_summary = hint.summary;
    candidate.screening_summary = [candidate.screening_summary, `LP edge: ${hint.summary}`]
      .filter(Boolean)
      .join(" | ");
  }

  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));

  const top = candidates.slice(0, limit);

  if (rejected.length > 0) {
    log("screening", `Rejected ${rejected.length} pool(s) in pre-filter phase`);
  }

  return {
    candidates: top,
    rejected: rejected.slice(0, 10), // trim for prompt size
    total_screened: pools.length,
    total_eligible: candidates.length,
    pipeline_summary: summarizePipeline(rejected, candidates),
  };
}

function evaluatePool(pool, screeningConfig) {
  const reasons = [];
  const strengths = [];
  const warnings = [];

  const launchpad = pool.launchpad?.toLowerCase?.() || "";
  let effectiveOrganic = pool.organic_score;
  for (const [key, penalty] of Object.entries(LAUNCHPAD_ORGANIC_PENALTY)) {
    if (launchpad.includes(key)) {
      effectiveOrganic = Math.max(0, effectiveOrganic + penalty);
      warnings.push(`launchpad penalty ${key} (${pool.organic_score}→${effectiveOrganic})`);
      log("screening", `Launchpad penalty for ${pool.name}: ${key} → organic ${pool.organic_score} → ${effectiveOrganic}`);
      break;
    }
  }

  if (pool.price_change_pct != null && pool.price_change_pct < -20) {
    reasons.push(`Price freefall: ${pool.price_change_pct}% (threshold: -20%)`);
  }
  if (pool.price_change_pct != null && pool.price_change_pct > screeningConfig.maxPriceChangePct) {
    reasons.push(`Price too extended: ${pool.price_change_pct}% (max: ${screeningConfig.maxPriceChangePct}%)`);
  }
  if (pool.volatility != null && pool.volatility > screeningConfig.maxVolatility) {
    reasons.push(`Volatility too high: ${pool.volatility} (max: ${screeningConfig.maxVolatility})`);
  }
  if (pool.volume_change_pct != null && pool.volume_change_pct < -60) {
    reasons.push(`Volume collapse: ${pool.volume_change_pct}% change (threshold: -60%)`);
  }
  if (effectiveOrganic < screeningConfig.minOrganic) {
    reasons.push(`Organic score too low: ${effectiveOrganic} (effective, min: ${screeningConfig.minOrganic})`);
  }

  if (reasons.length > 0) {
    return {
      eligible: false,
      stage: "hard-reject",
      effectiveOrganic,
      reasons,
      strengths,
      warnings,
      score: 0,
      summary: reasons.join(" | "),
    };
  }

  const feeScore = normalize(pool.fee_active_tvl_ratio, screeningConfig.minFeeActiveTvlRatio, screeningConfig.minFeeActiveTvlRatio * 6, 35);
  const volumeScore = normalize(pool.volume_window, screeningConfig.minVolume, screeningConfig.minVolume * 10, 20);
  const liquidityScore = normalize(pool.active_tvl, screeningConfig.minTvl, Math.min(screeningConfig.maxTvl, screeningConfig.minTvl * 8), 15);
  const organicScore = normalize(effectiveOrganic, screeningConfig.minOrganic, 90, 15);
  const participationScore = normalize(pool.active_pct, 10, 70, 10);
  const momentumScore = pool.price_change_pct == null
    ? 3
    : pool.price_change_pct < 0
      ? Math.max(0, 5 + pool.price_change_pct / 4)
      : Math.min(5, 1 + pool.price_change_pct / 8);
  const modeScore = pool.price_change_pct == null
    ? 0
    : pool.price_change_pct > 0
      ? Math.min(6, pool.price_change_pct / 30)
      : 0;

  const score = Math.max(0, Math.min(100, Math.round(
    feeScore + volumeScore + liquidityScore + organicScore + participationScore + momentumScore + modeScore
  )));

  if ((pool.fee_active_tvl_ratio || 0) >= screeningConfig.minFeeActiveTvlRatio * 2) strengths.push(`strong fee/TVL ${pool.fee_active_tvl_ratio}%`);
  if ((pool.volume_window || 0) >= screeningConfig.minVolume * 3) strengths.push(`volume ${pool.volume_window}`);
  if ((pool.active_pct || 0) >= 35) strengths.push(`healthy active range ${pool.active_pct}%`);
  if ((pool.price_change_pct || 0) < 0) warnings.push(`price trend ${pool.price_change_pct}%`);
  if ((pool.volume_change_pct || 0) < 0) warnings.push(`volume trend ${pool.volume_change_pct}%`);

  return {
    eligible: true,
    stage: score >= 75 ? "priority-shortlist" : score >= 60 ? "shortlist" : "watchlist",
    effectiveOrganic,
    reasons: [],
    strengths,
    warnings,
    score,
    summary: [
      `score ${score}/100`,
      strengths.length ? `strengths: ${strengths.join(", ")}` : null,
      warnings.length ? `warnings: ${warnings.join(", ")}` : null,
    ].filter(Boolean).join(" | "),
  };
}

function normalize(value, min, target, maxPoints) {
  if (value == null) return 0;
  if (value <= min) return 0;
  if (value >= target) return maxPoints;
  return ((value - min) / (target - min)) * maxPoints;
}

function summarizePipeline(rejected, candidates) {
  const hardRejects = rejected.filter((r) => r.stage === "hard-reject").length;
  const ownershipRejects = rejected.filter((r) => r.stage === "ownership").length;
  const shortlist = candidates.filter((c) => c.screening_stage === "priority-shortlist" || c.screening_stage === "shortlist").length;
  return {
    hard_rejects: hardRejects,
    ownership_rejects: ownershipRejects,
    shortlisted: shortlist,
    watchlist: candidates.filter((c) => c.screening_stage === "watchlist").length,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const pool = (data.data || [])[0];

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    // API sometimes returns 0 for fee_active_tvl_ratio on short timeframes — compute from raw values as fallback
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility: fix(p.volatility, 2),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
    launchpad: p.launchpad,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}
