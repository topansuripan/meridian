import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { getRecentSelfTuned } from "./memory.js";

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

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);
  const wins = perfLast24h.filter(p => p.pnl_usd > 0).length;
  const winRate = perfLast24h.length > 0 ? Math.round((wins / perfLast24h.length) * 100) : null;

  // 3. Lessons Learned (from lessons.json — last 24h)
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Self-tuned memory entries (from memory.json — last 24h)
  let selfTuned = [];
  try {
    selfTuned = getRecentSelfTuned(24);
  } catch { /* memory.json may not exist yet */ }

  // 5. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

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
    .map((p) => p.pool_name || p.pool || p.position)
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
    `💎 Fees Earned: $${formatUsd(totalFeesUsd)}`,
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
      ? `📊 All-time PnL: $${formatUsd(perfSummary.total_pnl_usd)} (${perfSummary.win_rate_pct}% win)`
      : `📊 All-time PnL: No data yet`,
    recentFocus.length > 0
      ? `🎯 Focus Now: ${recentFocus.join(", ")}`
      : `🎯 Focus Now: Screening for the next high-quality setup`,
    `────────────────`,
  ];

  return lines.join("\n");
}

function formatUsd(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
