import fs from "fs";
import { log } from "./logger.js";
import { addMemory, MemoryType } from "./memory.js";

const FILE = "./holographic-memory.json";

function load() {
  if (!fs.existsSync(FILE)) return { pools: {} };
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { pools: {} };
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function avg(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function pctNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const parsed = parseFloat(value.replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeStrategy(value) {
  const raw = String(value || "").toLowerCase();
  if (!raw) return "unknown";
  if (raw.includes("bid") || raw.includes("ask")) return "bid_ask";
  if (raw.includes("spot")) return "spot";
  return raw;
}

function ensurePoolEntry(db, poolAddress, poolName, baseMint) {
  if (!db.pools[poolAddress]) {
    db.pools[poolAddress] = {
      pool_address: poolAddress,
      pool_name: poolName || poolAddress?.slice(0, 8) || "unknown",
      base_mint: baseMint || null,
      outcomes: [],
      top_lp_studies: [],
      top_lp_playbook: null,
      updated_at: null,
    };
  }

  const entry = db.pools[poolAddress];
  if (poolName) entry.pool_name = poolName;
  if (baseMint && !entry.base_mint) entry.base_mint = baseMint;
  return entry;
}

function derivePlaybook(study) {
  const topPatterns = study?.patterns || {};
  const positions = (study?.lpers || []).flatMap((lper) => lper.positions || []);

  const strategyCounts = {};
  for (const position of positions) {
    const strategy = normalizeStrategy(position.strategy);
    if (strategy === "unknown") continue;
    strategyCounts[strategy] = (strategyCounts[strategy] || 0) + 1;
  }

  const preferredStrategy = Object.entries(strategyCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || (topPatterns.avg_hold_hours != null && topPatterns.avg_hold_hours < 1.5 ? "bid_ask" : "spot");

  const avgHoldHours = avg([
    topPatterns.avg_hold_hours,
    ...positions.map((position) => position.hold_hours).filter((value) => typeof value === "number"),
  ]);
  const avgWinRatePct = pctNumber(topPatterns.avg_win_rate);
  const avgRoiPct = pctNumber(topPatterns.avg_roi_pct);
  const avgInRangePct = avg(positions.map((position) => pctNumber(position.in_range_pct)));

  let dominantStyle = "balanced";
  if (avgHoldHours != null) {
    dominantStyle = avgHoldHours < 1.5 ? "scalper" : avgHoldHours >= 6 ? "holder" : "hybrid";
  } else if ((topPatterns.scalper_count || 0) > (topPatterns.holder_count || 0)) {
    dominantStyle = "scalper";
  } else if ((topPatterns.holder_count || 0) > 0) {
    dominantStyle = "holder";
  }

  const binsBelowHint = preferredStrategy === "spot"
    ? dominantStyle === "holder" ? 120 : 80
    : dominantStyle === "scalper" ? 42 : dominantStyle === "hybrid" ? 58 : 72;
  const binsAboveHint = preferredStrategy === "spot" ? 12 : 0;

  const confidence = clamp(
    ((topPatterns.top_lper_count || 0) * 18) +
    Math.min(25, positions.length * 2) +
    ((avgWinRatePct || 0) * 0.35),
    20,
    95
  );

  const degenFit = clamp(
    ((avgRoiPct || 0) * 0.6) +
    ((avgWinRatePct || 0) * 0.25) +
    (dominantStyle === "scalper" ? 12 : dominantStyle === "hybrid" ? 6 : 0),
    0,
    100
  );

  const playbookSummary = [
    `${preferredStrategy} bias`,
    dominantStyle,
    avgHoldHours != null ? `hold ${avgHoldHours.toFixed(1)}h` : null,
    avgWinRatePct != null ? `win ${avgWinRatePct.toFixed(0)}%` : null,
    avgRoiPct != null ? `roi ${avgRoiPct.toFixed(1)}%` : null,
    avgInRangePct != null ? `in-range ${avgInRangePct.toFixed(0)}%` : null,
  ].filter(Boolean).join(" | ");

  const degenNote = degenFit >= 70
    ? "Degen mode fit is high — top LPs are exploiting fast rotations with strong edge."
    : degenFit >= 50
      ? "Degen mode fit is moderate — can be pushed if momentum confirms."
      : "Degen mode fit is low — better as measured rotation than hyper-aggressive entry.";

  return {
    preferred_strategy: preferredStrategy,
    bins_below_hint: binsBelowHint,
    bins_above_hint: binsAboveHint,
    dominant_style: dominantStyle,
    avg_hold_hours: avgHoldHours != null ? Number(avgHoldHours.toFixed(2)) : null,
    avg_win_rate_pct: avgWinRatePct != null ? Number(avgWinRatePct.toFixed(1)) : null,
    avg_roi_pct: avgRoiPct != null ? Number(avgRoiPct.toFixed(1)) : null,
    avg_in_range_pct: avgInRangePct != null ? Number(avgInRangePct.toFixed(1)) : null,
    confidence: Number(confidence.toFixed(0)),
    degen_fit: Number(degenFit.toFixed(0)),
    playbook_summary: playbookSummary,
    degen_note: degenNote,
  };
}

function aggregateSimilarOutcomes(db, baseMint, excludePoolAddress = null) {
  if (!baseMint) return null;

  const related = Object.values(db.pools)
    .filter((entry) => entry.base_mint === baseMint && entry.pool_address !== excludePoolAddress)
    .flatMap((entry) => (entry.outcomes || []).map((outcome) => ({ ...outcome, pool_name: entry.pool_name })));

  if (!related.length) return null;

  const avgPnl = avg(related.map((outcome) => outcome.pnl_pct));
  const wins = related.filter((outcome) => (outcome.pnl_pct || 0) > 0).length;
  const strategies = {};

  for (const outcome of related) {
    const key = normalizeStrategy(outcome.strategy);
    if (!strategies[key]) strategies[key] = { count: 0, wins: 0, pnl: [] };
    strategies[key].count += 1;
    if ((outcome.pnl_pct || 0) > 0) strategies[key].wins += 1;
    if (typeof outcome.pnl_pct === "number") strategies[key].pnl.push(outcome.pnl_pct);
  }

  const bestStrategy = Object.entries(strategies)
    .map(([strategy, meta]) => ({
      strategy,
      score: (meta.wins / meta.count) * 100 + (avg(meta.pnl) || 0),
    }))
    .sort((a, b) => b.score - a.score)[0]?.strategy || null;

  return {
    sample_size: related.length,
    avg_pnl_pct: avgPnl != null ? Number(avgPnl.toFixed(2)) : null,
    win_rate_pct: Number(((wins / related.length) * 100).toFixed(1)),
    best_strategy: bestStrategy,
  };
}

export function recordTopLPStudy({ poolAddress, poolName, baseMint, study }) {
  if (!poolAddress || !study) return null;

  const db = load();
  const entry = ensurePoolEntry(db, poolAddress, poolName, baseMint);
  const playbook = derivePlaybook(study);

  entry.top_lp_studies.push({
    studied_at: new Date().toISOString(),
    patterns: study.patterns || {},
    sample_size: (study.lpers || []).length,
    playbook,
  });
  entry.top_lp_studies = entry.top_lp_studies.slice(-8);
  entry.top_lp_playbook = playbook;
  entry.updated_at = new Date().toISOString();
  save(db);

  addMemory(
    `Top LP playbook for ${entry.pool_name}: ${playbook.playbook_summary}. Preferred ${playbook.preferred_strategy} with ${playbook.bins_below_hint}/${playbook.bins_above_hint} bins.`,
    MemoryType.LP_LEARNED,
    { pinned: playbook.confidence >= 75, role: "SCREENER" }
  );
  log("holographic", `Saved top LP study for ${entry.pool_name}: ${playbook.playbook_summary}`);

  return playbook;
}

export function recordHolographicOutcome({
  poolAddress,
  poolName,
  baseMint,
  strategy,
  pnlPct,
  pnlUsd,
  minutesHeld,
  rangeEfficiency,
  closeReason,
}) {
  if (!poolAddress) return;

  const db = load();
  const entry = ensurePoolEntry(db, poolAddress, poolName, baseMint);
  entry.outcomes.push({
    closed_at: new Date().toISOString(),
    strategy: normalizeStrategy(strategy),
    pnl_pct: typeof pnlPct === "number" ? Number(pnlPct.toFixed(2)) : null,
    pnl_usd: typeof pnlUsd === "number" ? Number(pnlUsd.toFixed(2)) : null,
    minutes_held: minutesHeld ?? null,
    range_efficiency: rangeEfficiency ?? null,
    close_reason: closeReason || null,
  });
  entry.outcomes = entry.outcomes.slice(-20);
  entry.updated_at = new Date().toISOString();
  save(db);
}

export function getTopLPPlaybook({ pool_address, base_mint }) {
  const db = load();
  const direct = pool_address ? db.pools[pool_address] : null;
  if (direct?.top_lp_playbook) return direct.top_lp_playbook;

  if (!base_mint) return null;
  const sibling = Object.values(db.pools)
    .filter((entry) => entry.base_mint === base_mint && entry.top_lp_playbook)
    .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())[0];

  return sibling?.top_lp_playbook || null;
}

export function isTopLPStudyStale({ pool_address, base_mint, ttlHours = 24 }) {
  const db = load();
  const entry = pool_address ? db.pools[pool_address] : null;
  const updatedAt = entry?.updated_at || (
    base_mint
      ? Object.values(db.pools)
          .filter((item) => item.base_mint === base_mint)
          .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())[0]?.updated_at
      : null
  );

  if (!updatedAt) return true;
  return Date.now() - new Date(updatedAt).getTime() > ttlHours * 60 * 60 * 1000;
}

export function getHolographicRecall({ pool_address, base_mint, risk_mode = "moderate" }) {
  const db = load();
  const entry = pool_address ? db.pools[pool_address] : null;
  const lines = [];

  if (entry?.outcomes?.length) {
    const avgPnl = avg(entry.outcomes.map((outcome) => outcome.pnl_pct));
    const wins = entry.outcomes.filter((outcome) => (outcome.pnl_pct || 0) > 0).length;
    lines.push(
      `OUR POOL OUTCOMES: ${entry.outcomes.length} closes, avg PnL ${avgPnl != null ? avgPnl.toFixed(2) : "?"}%, win rate ${((wins / entry.outcomes.length) * 100).toFixed(0)}%`
    );
  }

  const playbook = getTopLPPlaybook({ pool_address, base_mint });
  if (playbook) {
    lines.push(
      `TOP LP PLAYBOOK: ${playbook.playbook_summary}. Preferred strategy ${playbook.preferred_strategy}, bins ${playbook.bins_below_hint}/${playbook.bins_above_hint}, confidence ${playbook.confidence}%`
    );
    if (risk_mode === "degen") {
      lines.push(`DEGEN READ: ${playbook.degen_note}`);
    }
  }

  const cluster = aggregateSimilarOutcomes(db, base_mint, pool_address);
  if (cluster) {
    lines.push(
      `SIMILAR TOKEN MEMORY: ${cluster.sample_size} related outcomes, avg PnL ${cluster.avg_pnl_pct ?? "?"}%, win rate ${cluster.win_rate_pct}%, best strategy ${cluster.best_strategy || "unknown"}`
    );
  }

  return lines.length ? lines.join("\n") : null;
}

export function getHolographicStrategyHint({ pool_address, base_mint, risk_mode = "moderate" }) {
  const playbook = getTopLPPlaybook({ pool_address, base_mint });
  if (!playbook) return null;

  const strategy = risk_mode === "degen" && playbook.degen_fit >= 65
    ? playbook.preferred_strategy
    : playbook.preferred_strategy === "spot" && playbook.confidence < 60
      ? "bid_ask"
      : playbook.preferred_strategy;

  const binsBelow = risk_mode === "degen"
    ? Math.max(35, Math.round(playbook.bins_below_hint * 0.9))
    : risk_mode === "safe"
      ? Math.round(playbook.bins_below_hint * 1.15)
      : playbook.bins_below_hint;

  const binsAbove = strategy === "spot"
    ? Math.max(8, playbook.bins_above_hint || 12)
    : 0;

  const scoreBoost = risk_mode === "degen"
    ? Math.round(playbook.degen_fit / 12)
    : risk_mode === "safe"
      ? Math.round(playbook.confidence / 20)
      : Math.round(playbook.confidence / 16);

  return {
    strategy,
    bins_below: binsBelow,
    bins_above: binsAbove,
    confidence: playbook.confidence,
    score_boost: scoreBoost,
    summary: `${strategy} | ${playbook.dominant_style} | bins ${binsBelow}/${binsAbove} | confidence ${playbook.confidence}% | degen fit ${playbook.degen_fit}%`,
  };
}
