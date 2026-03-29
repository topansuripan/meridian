import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { getRecentSelfTuned } from "./memory.js";
import { getConfiguredOwnerAddress, getHistoricalPositions, getOpeningPositions, getOverview, hasLpAgentKey } from "./tools/lpagent.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity — prefer LPAgent portfolio history when available.
  let perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  let totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  let totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);
  let totalPnlNative = null;
  let totalFeesNative = null;
  let wins = perfLast24h.filter(p => p.pnl_usd > 0).length;
  let winRate = perfLast24h.length > 0 ? Math.round((wins / perfLast24h.length) * 100) : null;

  let openPositions = allPositions.filter(p => !p.closed);
  let perfSummary = getPerformanceSummary();

  const owner = getConfiguredOwnerAddress();
  if (owner && hasLpAgentKey()) {
    try {
      const [historical, opening, overview] = await Promise.all([
        getHistoricalPositions({ owner, fromDate: last24h.toISOString(), toDate: now.toISOString(), limit: 100 }),
        getOpeningPositions({ owner }),
        getOverview({ owner }),
      ]);

      const rows = historical.data || [];
      if (rows.length > 0) {
        perfLast24h = rows.map((row) => ({
          pnl_usd: numberOrZero(row?.pnl?.value),
          pnl_pct: numberOrZero(row?.pnl?.percent),
          fees_earned_usd: numberOrZero(row?.collectedFee),
        }));
        totalPnLUsd = sumOf(rows, (row) => row?.pnl?.value);
        totalFeesUsd = sumOf(rows, (row) => row?.collectedFee);
        totalPnlNative = sumOf(rows, (row) => row?.pnl?.valueNative);
        totalFeesNative = sumOf(rows, (row) => row?.collectedFeeNative);
        wins = rows.filter((row) => numberOrZero(row?.pnl?.value) > 0).length;
        winRate = rows.length > 0 ? Math.round((wins / rows.length) * 100) : null;
      }

      openPositions = opening.data || [];
      if (overview) {
        perfSummary = {
          total_positions_closed: numberOrZero(overview.total_lp),
          total_pnl_usd: numberOrZero(overview.total_pnl?.ALL),
          total_pnl_native: numberOrZero(overview.total_pnl_native?.ALL),
          total_fees_usd: numberOrZero(overview.total_fee?.ALL),
          total_fees_native: numberOrZero(overview.total_fee_native?.ALL),
          win_rate_pct: percentFromCounts(overview.win_lp, overview.total_lp),
        };
      }
    } catch (error) {
      log("briefing_error", `LPAgent portfolio fallback failed: ${error.message}`);
    }
  }

  // 3. Lessons Learned (from lessons.json — last 24h)
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Self-tuned memory entries (from memory.json — last 24h)
  let selfTuned = [];
  try {
    selfTuned = getRecentSelfTuned(24);
  } catch { /* memory.json may not exist yet */ }

  // 6. Build "Lessons Learned" section — combine lessons + self-tuned memory
  const learnedLines = [];

  // Self-tuned entries first (most interesting to the operator)
  for (const m of selfTuned.slice(-5)) {
    learnedLines.push(`• [SELF-TUNED] ${m.text}`);
  }
  // Then any derived lessons from closed positions
  for (const l of lessonsLast24h.filter(l => l.outcome !== "manual").slice(-3)) {
    learnedLines.push(`• ${l.rule.slice(0, 120)}`);
  }
  if (learnedLines.length === 0) {
    learnedLines.push("• [STABLE] No major tuning changes or new lessons in the last 24h.");
  }

  const recentFocus = openPositions
    .slice(-2)
    .map((p) => p.pool_name || p.pairName || p.pair || p.pool || p.position)
    .filter(Boolean)
    .map(shortLabel);

  // 7. Format Message (Telegram card style)
  const pnlSign = totalPnLUsd >= 0 ? "+" : "";
  const lines = [
    `☀️ <b>Morning Briefing</b> (Last 24h)`,
    `────────────────`,
    ``,
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    ``,
    `<b>Performance:</b>`,
    `💰 Net PnL: ${pnlSign}$${formatUsd(totalPnLUsd)}`,
    totalPnlNative != null ? `🪙 Net PnL (SOL): ${formatSigned(totalPnlNative)} SOL` : null,
    `💎 Fees Earned: $${formatUsd(totalFeesUsd)}`,
    totalFeesNative != null ? `💠 Fees Earned (SOL): ${formatSigned(totalFeesNative)} SOL` : null,
    winRate !== null
      ? `📈 Win Rate (24h): ${winRate}%`
      : `📈 Win Rate (24h): N/A`,
    ``,
    `<b>Lessons Learned:</b>`,
    ...learnedLines,
    ``,
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${formatUsd(perfSummary.total_pnl_usd)}${perfSummary.total_pnl_native != null ? ` | ${formatSigned(perfSummary.total_pnl_native)} SOL` : ""} (${perfSummary.win_rate_pct}% win)`
      : `📊 All-time PnL: No data yet`,
    perfSummary?.total_fees_usd != null
      ? `💎 All-time Fees: $${formatUsd(perfSummary.total_fees_usd)}${perfSummary.total_fees_native != null ? ` | ${formatSigned(perfSummary.total_fees_native)} SOL` : ""}`
      : null,
    recentFocus.length > 0
      ? `🎯 Focus Now: ${recentFocus.join(", ")}`
      : `🎯 Focus Now: Screening for the next high-quality setup`,
    `────────────────`,
  ];

  return lines.filter(Boolean).join("\n");
}

export async function generateDailySummary() {
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  let todayPerf = (lessonsData.performance || []).filter((p) => {
    const recordedAt = new Date(p.recorded_at);
    return recordedAt >= startOfDay && recordedAt <= now;
  });

  let totalPnlNative = null;
  let totalFeesNative = null;

  const owner = getConfiguredOwnerAddress();
  if (owner && hasLpAgentKey()) {
    try {
      const historical = await getHistoricalPositions({
        owner,
        fromDate: startOfDay.toISOString(),
        toDate: now.toISOString(),
        limit: 200,
      });
      if ((historical.data || []).length > 0) {
        todayPerf = historical.data.map((row) => ({
          strategy: normalizeStrategy(row.strategyType),
          pnl_usd: numberOrZero(row?.pnl?.value),
          pnl_pct: numberOrZero(row?.pnl?.percent),
          pnl_native: numberOrZero(row?.pnl?.valueNative),
          fees_earned_usd: numberOrZero(row?.collectedFee),
          fees_earned_native: numberOrZero(row?.collectedFeeNative),
        }));
        totalPnlNative = sumOf(historical.data, (row) => row?.pnl?.valueNative);
        totalFeesNative = sumOf(historical.data, (row) => row?.collectedFeeNative);
      }
    } catch (error) {
      log("briefing_error", `LPAgent daily fallback failed: ${error.message}`);
    }
  }

  const wins = todayPerf.filter((p) => (p.pnl_usd || 0) > 0);
  const losses = todayPerf.filter((p) => (p.pnl_usd || 0) <= 0);
  const totalPnlUsd = todayPerf.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = todayPerf.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);
  const winRate = todayPerf.length > 0 ? Math.round((wins.length / todayPerf.length) * 100) : null;
  const avgWinPct = wins.length > 0
    ? wins.reduce((sum, p) => sum + (p.pnl_pct || 0), 0) / wins.length
    : null;
  const avgLossPct = losses.length > 0
    ? losses.reduce((sum, p) => sum + (p.pnl_pct || 0), 0) / losses.length
    : null;

  const byStrategy = new Map();
  for (const perf of todayPerf) {
    const key = perf.strategy || "unknown";
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(perf);
  }
  let bestStrategyLine = "No closes yet today";
  if (byStrategy.size > 0) {
    const best = [...byStrategy.entries()]
      .map(([strategy, rows]) => ({
        strategy,
        count: rows.length,
        avgPct: rows.reduce((sum, row) => sum + (row.pnl_pct || 0), 0) / rows.length,
      }))
      .sort((a, b) => b.avgPct - a.avgPct)[0];
    bestStrategyLine = `${best.strategy} (avg ${formatSigned(best.avgPct)}%, ${best.count} trade${best.count === 1 ? "" : "s"})`;
  }

  const lines = [
    `📖 <b>DAILY — ${formatDateOnly(startOfDay)}</b>`,
    ``,
    `📊 ${todayPerf.length} trades | ${wins.length}W ${losses.length}L`,
    `💰 PnL: ${formatSignedUsd(totalPnlUsd)}${totalPnlNative != null ? ` | ${formatSigned(totalPnlNative)} SOL` : ""}`,
    `💎 Fees Earned: $${formatUsd(totalFeesUsd)}`,
    totalFeesNative != null ? `💠 Fees Earned (SOL): ${formatSigned(totalFeesNative)} SOL` : null,
    `📈 Win rate: ${winRate != null ? `${winRate}%` : "N/A"}`,
    `✅ Avg profit: ${avgWinPct != null ? `${formatSigned(avgWinPct)}%` : "N/A"}`,
    `❌ Avg loss: ${avgLossPct != null ? `${formatSigned(avgLossPct)}%` : "N/A"}`,
    `🎯 Best: ${bestStrategyLine}`,
  ];

  return lines.filter(Boolean).join("\n");
}

function formatUsd(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSigned(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

function formatSignedUsd(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : "-"}$${formatUsd(Math.abs(n))}`;
}

function formatDateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sumOf(rows, picker) {
  return rows.reduce((sum, row) => sum + numberOrZero(picker(row)), 0);
}

function percentFromCounts(wins, total) {
  const a = numberOrZero(wins);
  const b = numberOrZero(total);
  return b > 0 ? Math.round((a / b) * 100) : null;
}

function normalizeStrategy(value) {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  return text
    .replace(/ImBalanced/gi, "")
    .replace(/Balanced/gi, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function shortLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "Unknown";
  if (text.length <= 24) return text;
  return `${text.slice(0, 20)}...`;
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
