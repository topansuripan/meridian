import "dotenv/config";
import cron from "node-cron";
import fs from "fs";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, getPositionPnl, closePosition } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary, listLessons } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendHTML,
  sendTyping,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  sendMainMenu,
  sendSettingsMenu,
  TELEGRAM_LABELS,
  getScheduleMenuMarkup,
  getTradeSettingsMenuMarkup,
  getRiskSettingsMenuMarkup,
  getPositionsMenuMarkup,
  getPositionActionMenuMarkup,
  syncTelegramCommands,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import {
  getLastBriefingDate,
  setLastBriefingDate,
  getTrackedPosition,
  setPositionInstruction,
  setLastCycleReport,
  getLastCycleReport,
  shouldSendAlert,
} from "./state.js";
import { listMemory, addMemory, MemoryType } from "./memory.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool } from "./pool-memory.js";
import { getHolographicRecall, getHolographicStrategyHint, isTopLPStudyStale } from "./holographic-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenHolders, getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { studyTopLPers } from "./tools/study.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);

const TP_PCT  = config.management.takeProfitFeePct;
const DEPLOY  = config.management.deployAmountSol;
const USER_CONFIG_PATH = "./user-config.json";

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt  = config.schedule.managementMode === "manual"
    ? "manual"
    : config.schedule.managementMode === "nonstop"
      ? "24/7"
    : formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn  = config.schedule.screeningMode === "manual"
    ? "manual"
    : config.schedule.screeningMode === "nonstop"
      ? "24/7"
    : formatCountdown(nextRunIn(timers.screeningLastRun,  config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _screeningPausedForCapacity = false; // when full, let management own the loop until a slot opens

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  _cronTasks = [];
}

export async function runManagementCycle({ delivery = "full" } = {}) {
  log("cron", `Starting management cycle [model: ${config.llm.managementModel}]`);
  let mgmtReport = null;
  let positions = [];
  try {
      // Pre-load all positions + PnL in parallel — LLM gets everything, no fetch steps needed
      const livePositions = await getMyPositions().catch(() => null);
      positions = livePositions?.positions || [];
      _screeningPausedForCapacity = positions.length >= config.risk.maxPositions;

      if (positions.length === 0) {
        log("cron", "No open positions");
        mgmtReport = "No open positions.";
        _screeningPausedForCapacity = false;
        if (config.schedule.screeningMode === "interval" || config.schedule.screeningMode === "nonstop") {
          log("cron", `No open positions — triggering screening cycle because screening mode is ${config.schedule.screeningMode}`);
          runScreeningCycle({ delivery: "alerts" }).catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
        }
        return mgmtReport;
      }

      if (config.schedule.autoAdjustManagementInterval && config.schedule.managementMode === "interval") {
        const maxVolatility = positions.reduce((max, p) => {
          const tracked = getTrackedPosition(p.position);
          return Math.max(max, tracked?.volatility ?? 0);
        }, 0);
        const targetInterval = maxVolatility >= 5 ? 3 : maxVolatility >= 2 ? 5 : 10;
        if (config.schedule.managementIntervalMin !== targetInterval) {
          config.schedule.managementIntervalMin = targetInterval;
          log("cron", `Management interval adjusted to ${targetInterval}m (max volatility: ${maxVolatility})`);
          if (cronStarted) startCronJobs();
        }
      }

      // Also trigger screening if under max positions, but only when screening is interval-based
      const screeningCooldownMs = 5 * 60 * 1000;
      if (
        (config.schedule.screeningMode === "interval" || config.schedule.screeningMode === "nonstop") &&
        positions.length < config.risk.maxPositions &&
        Date.now() - _screeningLastTriggered > screeningCooldownMs
      ) {
        _screeningLastTriggered = Date.now();
        log("cron", `Positions (${positions.length}/${config.risk.maxPositions}) — triggering screening in background`);
        runScreeningCycle({ delivery: "alerts" }).catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      }

      // Snapshot + PnL fetch in parallel for all positions
      const positionData = await Promise.all(positions.map(async (p) => {
        recordPositionSnapshot(p.pool, p);
        const pnl = await getPositionPnl({ pool_address: p.pool, position_address: p.position }).catch(() => null);
        const recall = recallForPool(p.pool);
        return { ...p, pnl, recall };
      }));

      // Build pre-loaded position blocks for the LLM
      const positionBlocks = positionData.map((p) => {
        const pnl = p.pnl;
        const lines = [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  age: ${p.age_minutes ?? "?"}m | in_range: ${p.in_range} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          pnl ? `  pnl_pct: ${pnl.pnl_pct}% | pnl_usd: $${pnl.pnl_usd} | unclaimed_fees: $${pnl.unclaimed_fee_usd} | claimed_fees: $${Math.max(0, (pnl.all_time_fees_usd || 0) - (pnl.unclaimed_fee_usd || 0)).toFixed(2)} | value: $${pnl.current_value_usd} | fee_per_tvl_24h: ${pnl.fee_per_tvl_24h ?? "?"}%` : `  pnl: fetch failed`,
          pnl ? `  bins: lower=${pnl.lower_bin} upper=${pnl.upper_bin} active=${pnl.active_bin}` : null,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
          p.recall ? `  memory: ${p.recall}` : null,
        ].filter(Boolean);
        return lines.join("\n");
      }).join("\n\n");

      // Hive mind pattern consensus (if enabled)
      let hivePatterns = "";
      try {
        const hiveMind = await import("./hive-mind.js");
        if (hiveMind.isEnabled()) {
          const patterns = await hiveMind.queryPatternConsensus();
          const significant = (patterns || []).filter(p => p.count >= 10);
          if (significant.length > 0) {
            hivePatterns = `\nHIVE MIND PATTERNS (supplementary):\n${significant.slice(0, 3).map(p => `[HIVE] ${p.strategy}: ${p.win_rate}% win, ${p.avg_pnl}% avg PnL (${p.count} deploys)`).join("\n")}\n`;
          }
        }
      } catch { /* hive is best-effort */ }

      const { content } = await agentLoop(`
MANAGEMENT CYCLE — ${positions.length} position(s)

PRE-LOADED POSITION DATA (no fetching needed):
${positionBlocks}${hivePatterns}

HARD CLOSE RULES — apply in order, first match wins:
1. instruction set AND condition met → CLOSE (highest priority)
2. instruction set AND condition NOT met → HOLD, skip remaining rules
3. pnl_pct <= ${config.management.emergencyPriceDropPct}% → CLOSE (stop loss)
4. pnl_pct >= ${config.management.takeProfitFeePct}% → CLOSE (take profit)
5. active_bin > upper_bin + ${config.management.outOfRangeBinsToClose} → CLOSE (pumped far above range)
6. active_bin > upper_bin AND oor_minutes >= ${config.management.outOfRangeWaitMinutes} → CLOSE (stale above range)
7. fee_per_tvl_24h < ${config.management.minFeePerTvl24h} AND age_minutes >= 60 → CLOSE (fee yield too low)

CLAIM RULE: If unclaimed_fee_usd >= ${config.management.minClaimAmount}, call claim_fees. Do not use any other threshold.

INSTRUCTIONS:
All data is pre-loaded above — do NOT call get_my_positions or get_position_pnl.
Apply the rules to each position and write your report immediately.
Only call tools if a position needs to be CLOSED, FLIPPED, or fees need to be CLAIMED.
If all positions STAY and no fees to claim, just write the report with no tool calls.

REPORT FORMAT (one per position):
**[PAIR]** | Age: [X]m | Unclaimed: $[X] | PnL: [X]% | [STAY/CLOSE]
Range: [████████░░░░░░░░░░░░] (20 chars: █ = bins up to active, ░ = bins above active)
Only add: **Rule [N]:** [reason] — if a close rule triggered. Omit rule line if STAY with no rule.

After all positions, add one summary line:
💼 [N] positions | $[total_value] | fees today: $[sum_unclaimed] | [any notable action taken]
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 4096);
      mgmtReport = content;
    } catch (error) {
      log("cron_error", `Management cycle failed: ${error.message}`);
      mgmtReport = `Management cycle failed: ${error.message}`;
    } finally {
      cacheCycleReport("management", mgmtReport, { generated_at: new Date().toISOString() });
      if (delivery === "full" && telegramEnabled() && mgmtReport) {
        sendHTML(formatManagementTelegramReport(mgmtReport) || `🔄 <b>Management Cycle</b>\n\n${escapeHtml(mgmtReport)}`).catch(() => {});
      }
      if (delivery !== "silent" && telegramEnabled()) {
        for (const p of positions) {
          if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
            const alertKey = `oor:${p.position}`;
            if (shouldSendAlert(alertKey, 2 * 60 * 60_000)) {
              notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => {});
            }
          }
        }
      }
    }
  return mgmtReport;
}

export async function runScreeningCycle({ delivery = "full" } = {}) {
    if (_screeningBusy) return;
    if (_screeningPausedForCapacity) {
      log("cron", "Screening paused — portfolio already at max positions, waiting for management to free a slot");
      return "Screening paused until a position slot opens.";
    }

    // Hard guards — don't even run the agent if preconditions aren't met
    let prePositions, preBalance;
    let rejected = [];
    let screenReport = null;
    try {
      [prePositions, preBalance] = await Promise.all([getMyPositions(), getWalletBalances()]);
      if (prePositions.total_positions >= config.risk.maxPositions) {
        _screeningPausedForCapacity = true;
        log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
        screenReport = `Risk limit reached. Open positions ${prePositions.total_positions}/${config.risk.maxPositions}. Screening paused until a slot opens.`;
        cacheCycleReport("screening", screenReport, { rejected, generated_at: new Date().toISOString(), reason: "max_positions" });
        if (delivery !== "silent") {
          await sendScreeningAlert(
            "Risk Limit Reached",
            [
              `Open positions: ${prePositions.total_positions}/${config.risk.maxPositions}`,
              "Screening menemukan tidak ada slot baru untuk deploy.",
            ],
            "screening:max_positions",
            60 * 60_000
          );
        }
        return screenReport;
      }
      _screeningPausedForCapacity = false;
      const minRequired = config.management.deployAmountSol + config.management.gasReserve;
      if (preBalance.sol < minRequired) {
        log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
        screenReport = `Insufficient SOL. Wallet has ${preBalance.sol.toFixed(4)} SOL, but ${minRequired.toFixed(4)} SOL is needed for deploy + gas reserve.`;
        cacheCycleReport("screening", screenReport, { rejected, generated_at: new Date().toISOString(), reason: "insufficient_sol" });
        if (delivery !== "silent") {
          await sendScreeningAlert(
            "Saldo Kurang Untuk Screening",
            [
              `SOL tersedia: ${preBalance.sol.toFixed(4)}`,
              `Minimal aman untuk deploy: ${minRequired.toFixed(4)} SOL`,
            ],
            "screening:insufficient_sol",
            45 * 60_000
          );
        }
        return screenReport;
      }
    } catch (e) {
      log("cron_error", `Screening pre-check failed: ${e.message}`);
      return;
    }

    _screeningBusy = true;
    timers.screeningLastRun = Date.now();
    log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
    try {
      // Reuse pre-fetched balance — no extra RPC call needed
      const currentBalance = preBalance;
      const deployAmount = computeDeployAmount(currentBalance.sol);
      log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

      // Load active strategy
      const activeStrategy = getActiveStrategy();
      const riskMode = config.profile?.riskMode || "moderate";
      const riskModeBlock = riskMode === "degen"
        ? `RISK MODE: DEGEN — be more aggressive only when top-LP playbook confidence is strong, momentum is real, and organic/smart-wallet evidence confirms the move.`
        : riskMode === "safe"
          ? `RISK MODE: SAFE — prefer durable, lower-volatility setups and avoid overextended momentum.`
          : `RISK MODE: MODERATE — balance safety and upside; demand both fees and believable narrative.`;
      const strategyBlock = activeStrategy
        ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
        : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

      // Pre-load top candidates + all recon data in parallel (saves 4-6 LLM steps)
      const topCandidates = await getTopCandidates({ limit: 5 }).catch(() => null);
      const candidates = topCandidates?.candidates || topCandidates?.pools || [];
      rejected = topCandidates?.rejected || [];
      const pipelineSummary = topCandidates?.pipeline_summary;

      const candidateBlocks = [];
      for (const [index, pool] of candidates.slice(0, 5).entries()) {
        const mint = pool.base?.mint;
        if (
          index < (config.profile?.topLpAutoLearnLimit ?? 0) &&
          config.profile?.autoLearnTopLps &&
          mint &&
          isTopLPStudyStale({
            pool_address: pool.pool,
            base_mint: mint,
            ttlHours: config.profile?.topLpStudyTtlHours ?? 24,
          })
        ) {
          try {
            await studyTopLPers({ pool_address: pool.pool, limit: 4, pool_name: pool.name, base_mint: mint });
          } catch (error) {
            log("screening", `Top LP auto-learn skipped for ${pool.name}: ${error.message}`);
          }
        }

        const [smartWallets, holders, narrative, tokenInfo, poolMemory] = await Promise.allSettled([
            checkSmartWalletsOnPool({ pool_address: pool.pool }),
            mint ? getTokenHolders({ mint, limit: 100 }) : Promise.resolve(null),
            mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
            mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
            Promise.resolve(recallForPool(pool.pool)),
          ]);

          const sw   = smartWallets.status === "fulfilled" ? smartWallets.value : null;
          const h    = holders.status === "fulfilled" ? holders.value : null;
          const n    = narrative.status === "fulfilled" ? narrative.value : null;
          const ti   = tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null;
          const mem  = poolMemory.value;

          const priceChange = ti?.stats_1h?.price_change;
          const netBuyers = ti?.stats_1h?.net_buyers;

          // Use Jupiter audit for bot/top holders (more reliable than custom detection)
          const botPct    = ti?.audit?.bot_holders_pct ?? h?.bundlers_pct_in_top_100 ?? "?";
          const top10Pct  = ti?.audit?.top_holders_pct ?? h?.top_10_real_holders_pct ?? "?";
          const launchpad = ti?.launchpad ?? null;
          const feesSol   = ti?.global_fees_sol ?? h?.global_fees_sol ?? "?";
          const holographicRecall = getHolographicRecall({
            pool_address: pool.pool,
            base_mint: mint,
            risk_mode: riskMode,
          });
          const strategyHint = getHolographicStrategyHint({
            pool_address: pool.pool,
            base_mint: mint,
            risk_mode: riskMode,
          });

          // Hard filter: skip blocked launchpads before even showing to LLM
          if (launchpad && config.screening.blockedLaunchpads.length > 0) {
            if (config.screening.blockedLaunchpads.includes(launchpad)) {
              log("screening", `Skipping ${pool.name} — blocked launchpad: ${launchpad}`);
              continue;
            }
          }

          // Build compact block
          const lines = [
            `POOL: ${pool.name} (${pool.pool})`,
            `  metrics: score=${pool.score ?? "?"}/100, bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}`,
            `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
            pool.screening_summary ? `  pipeline: ${pool.screening_summary}` : null,
            strategyHint ? `  strategy_hint: ${strategyHint.summary}` : null,
            `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
            priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
            n?.narrative ? `  narrative: ${n.narrative.slice(0, 500)}` : `  narrative: none`,
            mem ? `  memory: ${mem}` : null,
            holographicRecall ? `  holographic: ${holographicRecall}` : null,
          ].filter(Boolean);

          candidateBlocks.push(lines.join("\n"));
      }

      let candidateContext = candidateBlocks.length > 0
        ? `\nPRE-LOADED CANDIDATE ANALYSIS (smart wallets, holders, narrative already fetched):\n${candidateBlocks.join("\n\n")}\n`
        : "";

      if (pipelineSummary) {
        candidateContext += `\nPIPELINE SUMMARY:\n  hard_rejects=${pipelineSummary.hard_rejects}, ownership_rejects=${pipelineSummary.ownership_rejects}, shortlisted=${pipelineSummary.shortlisted}, watchlist=${pipelineSummary.watchlist}\n`;
      }

      // Add pre-filter skip summary so the agent knows what was already rejected
      if (rejected.length > 0) {
        const skipBlock = rejected.map(r => `  SKIPPED: ${r.pool} — ${r.reason}`).join("\n");
        candidateContext += `\nPRE-FILTER REJECTIONS (code-level, do NOT re-evaluate these):\n${skipBlock}\n`;
      }

      // Hive mind consensus (if enabled)
      try {
        const hiveMind = await import("./hive-mind.js");
        if (hiveMind.isEnabled()) {
          const poolAddrs = candidates.map(c => c.pool).filter(Boolean);
          if (poolAddrs.length > 0) {
            const hive = await hiveMind.formatPoolConsensusForPrompt(poolAddrs);
            if (hive) candidateContext += "\n" + hive + "\n";
          }
        }
      } catch { /* hive is best-effort */ }

      const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
${riskModeBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL
${candidateContext}
DECISION RULES:
- HARD SKIP if fees < ${config.screening.minTokenFeesSol} SOL (bundled/scam)
- HARD SKIP if top10 > ${config.screening.maxTop10Pct}% OR bots > ${config.screening.maxBundlersPct}%
${config.screening.blockedLaunchpads.length ? `- HARD SKIP if launchpad is any of: ${config.screening.blockedLaunchpads.join(", ")}` : ""}
- SKIP if narrative is empty/null or pure hype with no specific story (unless smart wallets present)
- Bots 5–25% are normal, not a skip reason on their own
- Smart wallets present → strong confidence boost
- If a candidate includes strategy_hint / holographic recall, prefer that deploy style unless live metrics clearly contradict it
- In degen mode, only lean aggressive when LP playbook confidence is high and the pool still passes safety filters

STEPS:
1. Pick the best candidate. If none pass, report why and stop.
2. Call deploy_position with ${deployAmount} SOL. Set bins_below = round(35 + (volatility/5)*34) clamped to [35,69].
3. Report result.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048);
      screenReport = content;
    } catch (error) {
      log("cron_error", `Screening cycle failed: ${error.message}`);
      screenReport = `Screening cycle failed: ${error.message}`;
    } finally {
      _screeningBusy = false;
      cacheCycleReport("screening", screenReport, { rejected, generated_at: new Date().toISOString() });
      if (telegramEnabled()) {
        const deployFailureReason = extractDeployFailureReason(screenReport);
        if (delivery !== "silent" && deployFailureReason) {
          sendScreeningAlert(
            "Candidate Bagus Tapi Deploy Gagal",
            [deployFailureReason],
            "screening:deploy_failed",
            30 * 60_000
          ).catch(() => {});
        }
        if (delivery === "full" && screenReport) {
          sendHTML(formatScreeningTelegramReport(screenReport, rejected) || `🔍 <b>Screening Cycle</b>\n\n${escapeHtml(screenReport)}`).catch(() => {});
        }
      }
    }
    return screenReport;
  }

export function startCronJobs() {
  stopCronJobs();

  if (config.schedule.managementMode === "interval" || config.schedule.managementMode === "nonstop") {
    const managementSchedule = config.schedule.managementMode === "nonstop"
      ? "* * * * *"
      : `*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`;
    const mgmtTask = cron.schedule(managementSchedule, async () => {
      if (_managementBusy) return;
      _managementBusy = true;
      timers.managementLastRun = Date.now();
      try { await runManagementCycle({ delivery: "alerts" }); }
      finally { _managementBusy = false; }
    });
    _cronTasks.push(mgmtTask);
  }

  if (config.schedule.screeningMode === "interval" || config.schedule.screeningMode === "nonstop") {
    const screeningSchedule = config.schedule.screeningMode === "nonstop"
      ? "* * * * *"
      : `*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`;
    const screenTask = cron.schedule(screeningSchedule, () => runScreeningCycle({ delivery: "alerts" }));
    _cronTasks.push(screenTask);
  }

  if (config.schedule.healthCheckEnabled) {
    const healthTask = cron.schedule(`*/${Math.max(1, config.schedule.healthCheckIntervalMin)} * * * *`, async () => {
      if (_managementBusy) return;
      _managementBusy = true;
      log("cron", "Starting health check");
      try {
        await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
      } catch (error) {
        log("cron_error", `Health check failed: ${error.message}`);
      } finally {
        _managementBusy = false;
      }
    });
    _cronTasks.push(healthTask);
  }

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  _cronTasks.push(briefingTask, briefingWatchdog);
  log(
    "cron",
    `Cycles started — management ${config.schedule.managementMode}${config.schedule.managementMode === "interval" ? `/${config.schedule.managementIntervalMin}m` : ""}, screening ${config.schedule.screeningMode}${config.schedule.screeningMode === "interval" ? `/${config.schedule.screeningIntervalMin}m` : ""}, health ${config.schedule.healthCheckEnabled ? `${config.schedule.healthCheckIntervalMin}m` : "off"}`
  );
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name   = (p.name || "unknown").padEnd(20);
    const score  = String(p.score ?? "?").padStart(4);
    const ftvl   = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol    = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org    = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  score:${score}  fee/aTVL:${ftvl}  vol:${vol}  active:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  score  fee/aTVL     vol    active  organic",
    "  " + "─".repeat(78),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function captureOperatorPreference(text, source = "operator") {
  if (!text || text.startsWith("/")) return;
  const compact = text.trim();
  const preferenceSignal = /^(aku mau|saya mau|gue mau|tolong|jangan|prefer|always|please|buat|ubah|set)/i.test(compact);
  if (!preferenceSignal || compact.length < 20) return;
  addMemory(`Operator preference (${source}): ${compact}`, MemoryType.USER_TAUGHT, {
    pinned: true,
    role: "GENERAL",
  });
}

function formatScheduleMode(mode, interval) {
  if (mode === "manual") return "manual";
  if (mode === "nonstop") return "24/7 nonstop";
  return `auto tiap ${interval}m`;
}

function formatLastRunLabel(timestamp) {
  if (!timestamp) return "belum ada";
  return new Date(timestamp).toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function screeningAlertModeLabel() {
  if (config.schedule.screeningMode === "manual") return "manual";
  return "alert only";
}

function managementAlertModeLabel() {
  if (config.schedule.managementMode === "manual") return "manual";
  return "silent + critical alerts";
}

function riskModeLabel() {
  const mode = config.profile?.riskMode || "moderate";
  if (mode === "degen") return "degen";
  if (mode === "safe") return "safe";
  return "moderate";
}

function riskModeBrief() {
  const mode = config.profile?.riskMode || "moderate";
  if (mode === "degen") return "aggressive, LP-backed momentum";
  if (mode === "safe") return "defensive, capital-preserving";
  return "balanced, selective rotation";
}

function isRiskModeButton(text, mode) {
  const normalized = String(text || "").trim();
  if (mode === "safe") return /safe$/i.test(normalized);
  if (mode === "moderate") return /moderate$/i.test(normalized);
  if (mode === "degen") return /degen$/i.test(normalized);
  return false;
}

function formatUsd(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPositionName(position) {
  const pair = position?.pair || "Unknown";
  if (pair.includes("/")) return pair;
  if (pair.length <= 18) return pair;
  return `${pair.slice(0, 8)}...${pair.slice(-4)}`;
}

function positionMood(position) {
  if (!position.in_range) return "⚠️";
  if ((position.pnl_usd || 0) > 0 || (position.unclaimed_fees_usd || 0) > 0) return "🟢";
  return "🔵";
}

function rangeLabel(position) {
  if (position.in_range) return "In range";
  const minutes = position.minutes_out_of_range ?? 0;
  return `Out of range ${minutes}m`;
}

function ageLabel(minutes) {
  if (minutes == null) return "?";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function shortHash(value, head = 10, tail = 6) {
  const text = String(value || "");
  if (!text) return "-";
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function stripMarkdown(value) {
  return String(value ?? "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/`/g, "")
    .trim();
}

function formatManagementTelegramReport(report) {
  const text = String(report || "").trim();
  if (!text) return null;

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\*\*\[(.+?)\]\*\*\s+\|\s+Age:\s+(.+?)\s+\|\s+Unclaimed:\s+\$?(.+?)\s+\|\s+PnL:\s+(.+?)\s+\|\s+(STAY|CLOSE)$/i);
    if (!match) continue;

    const [, pair, age, unclaimed, pnl, action] = match;
    const range = lines[i + 1]?.startsWith("Range:") ? lines[i + 1].replace(/^Range:\s*/i, "") : null;
    const rule = lines[i + 2]?.startsWith("Rule") ? lines[i + 2] : null;
    blocks.push({ pair, age, unclaimed, pnl, action: action.toUpperCase(), range, rule });
  }

  const summaryLine = lines.find((line) => line.startsWith("💼")) || null;
  if (blocks.length === 0) {
    return `🔄 <b>Management Cycle</b>\n────────────────\n${escapeHtml(stripMarkdown(text))}`;
  }

  const formattedBlocks = blocks.map((block) => {
    const pnlNum = parseFloat(String(block.pnl).replace("%", "")) || 0;
    const mood = block.action === "CLOSE" ? "🔴" : pnlNum >= 0 ? "🟢" : "🟡";
    const pnlEmoji = pnlNum >= 0 ? "📈" : "📉";
    const actionText = block.action === "CLOSE" ? "Close / rotate" : "Stay / monitor";
    return [
      `${mood} <b>${escapeHtml(block.pair)}</b>`,
      `⏳ Age: ${escapeHtml(block.age)}   💎 Fees: $${escapeHtml(block.unclaimed)}   ${pnlEmoji} PnL: ${escapeHtml(block.pnl)}`,
      `🧭 Action: <b>${escapeHtml(actionText)}</b>`,
      block.rule ? `⚠️ Trigger: ${escapeHtml(stripMarkdown(block.rule))}` : null,
      block.range ? `📊 Range: <code>${escapeHtml(block.range)}</code>` : null,
    ].filter(Boolean).join("\n");
  });

  return [
    `🔄 <b>Management Cycle</b>`,
    `────────────────`,
    ...formattedBlocks,
    summaryLine ? `💼 <b>Portfolio Summary</b>\n${escapeHtml(stripMarkdown(summaryLine.replace(/^💼\s*/, "")))}` : null,
  ].filter(Boolean).join("\n\n");
}

function formatScreeningTelegramReport(report, rejected = []) {
  const text = String(report || "").trim();
  if (!text) return null;

  const rawLines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const cleanedLines = [];

  for (const line of rawLines) {
    if (/^\|[-\s|]+\|?$/.test(line)) continue;
    if (line.startsWith("|")) {
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      if (cells.length >= 2) cleanedLines.push(`• ${cells[0]}: ${cells.slice(1).join(" | ")}`);
      continue;
    }
    cleanedLines.push(stripMarkdown(line));
  }

  const insufficient = cleanedLines.find((line) => /Insufficient SOL/i.test(line));
  const walletReason = cleanedLines.find((line) => /wallet SOL balance/i.test(line) || /required .*deploy/i.test(line));
  const noAction = cleanedLines.find((line) => /NO ACTION/i.test(line));
  const currentStateIndex = cleanedLines.findIndex((line) => /Current State/i.test(line));
  const nextStepsIndex = cleanedLines.findIndex((line) => /Next Steps/i.test(line));

  const currentState = currentStateIndex >= 0
    ? cleanedLines.slice(currentStateIndex + 1, nextStepsIndex >= 0 ? nextStepsIndex : undefined).filter((line) => line.startsWith("-"))
    : [];
  const nextSteps = nextStepsIndex >= 0
    ? cleanedLines.slice(nextStepsIndex + 1).filter(Boolean)
    : [];
  const highlights = cleanedLines
    .filter((line) =>
      !/Pre-filtered|Insufficient SOL|Current State|Next Steps|NO ACTION/i.test(line) &&
      !line.startsWith("-")
    )
    .slice(0, 4);

  return [
    `🔍 <b>Screening Cycle</b>`,
    `────────────────`,
    rejected.length ? `🚫 <b>Pre-filtered:</b> ${escapeHtml(rejected.map((r) => r.pool).join(", "))}` : null,
    insufficient ? `🧯 <b>Capital Check:</b> Insufficient SOL to deploy safely.` : null,
    walletReason ? `💸 ${escapeHtml(walletReason)}` : null,
    noAction ? `🧊 <b>Result:</b> No action this cycle.` : null,
    currentState.length ? `<b>Current State</b>\n${currentState.map((line) => `• ${escapeHtml(line.replace(/^-+\s*/, ""))}`).join("\n")}` : null,
    highlights.length ? `<b>Highlights</b>\n${highlights.map((line) => `• ${escapeHtml(line)}`).join("\n")}` : null,
    nextSteps.length ? `<b>Next Step</b>\n${nextSteps.map((line) => `• ${escapeHtml(line.replace(/^-+\s*/, ""))}`).join("\n")}` : null,
  ].filter(Boolean).join("\n\n");
}

function cacheCycleReport(kind, report, extra = {}) {
  if (!report) return;
  setLastCycleReport(kind, {
    report,
    ...extra,
  });
}

async function sendLastCycleReport(kind) {
  const cached = getLastCycleReport(kind);
  if (!cached?.report) {
    await sendMessage(kind === "management"
      ? "Belum ada management report tersimpan."
      : "Belum ada screening report tersimpan.");
    return false;
  }

  const formatted = kind === "management"
    ? formatManagementTelegramReport(cached.report)
    : formatScreeningTelegramReport(cached.report, cached.rejected || []);
  const stamped = `🕒 Last run: ${escapeHtml(formatLastRunLabel(cached.updated_at || cached.generated_at))}`;

  await sendHTML([stamped, "", formatted || escapeHtml(cached.report)].join("\n"));
  return true;
}

async function sendScreeningAlert(title, bodyLines, alertKey, cooldownMs = 30 * 60_000) {
  if (!telegramEnabled()) return;
  if (!shouldSendAlert(alertKey, cooldownMs)) return;
  await sendHTML([
    `🚨 <b>${escapeHtml(title)}</b>`,
    ...bodyLines.map((line) => escapeHtml(line)),
  ].join("\n")).catch(() => {});
}

function extractDeployFailureReason(report) {
  const text = stripMarkdown(report || "");
  if (!text) return null;
  if (!/deploy|open position/i.test(text) || !/fail|failed|error|unable|rejected/i.test(text)) {
    return null;
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /fail|failed|error|unable|rejected/i.test(line)) || "Candidate looked good, but deploy failed.";
}

async function sendTelegramStatusCard() {
  const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
  const inRange = positions.positions.filter((p) => p.in_range).length;
  const outOfRange = positions.total_positions - inRange;
  const lastMgmtReport = getLastCycleReport("management");
  const lastScreenReport = getLastCycleReport("screening");
  const lastMgmt = formatLastRunLabel(lastMgmtReport?.updated_at || timers.managementLastRun);
  const lastScreen = formatLastRunLabel(lastScreenReport?.updated_at || timers.screeningLastRun);
  await sendHTML([
    `🌟 <b>Meridian Control Center</b>`,
    `────────────────`,
    ``,
    `<b>Wallet Snapshot</b>`,
    `💠 SOL Balance: <b>${wallet.sol}</b>`,
    `💵 Est. Value: <b>$${formatUsd(wallet.sol_usd)}</b>`,
    ``,
    `<b>Portfolio Pulse</b>`,
    `📂 Open Positions: <b>${positions.total_positions}</b>`,
    `🟢 Healthy: ${inRange}`,
    `⚠️ Need Attention: ${outOfRange}`,
    ``,
    `<b>Automation</b>`,
    `🤖 Management: ${formatScheduleMode(config.schedule.managementMode, config.schedule.managementIntervalMin)}`,
    `🧭 Screening: ${_screeningPausedForCapacity ? "paused (max positions)" : formatScheduleMode(config.schedule.screeningMode, config.schedule.screeningIntervalMin)}`,
    `🔥 Risk Mode: ${riskModeLabel()} (${riskModeBrief()})`,
    `🔕 Mgmt feed: ${managementAlertModeLabel()}`,
    `🚨 Screen feed: ${screeningAlertModeLabel()}`,
    ``,
    `<b>Recent Activity</b>`,
    `🕒 Last Management: ${lastMgmt}`,
    `🕒 Last Screening: ${lastScreen}`,
    `────────────────`,
  ].join("\n"));
}

async function sendTelegramPositionsCard() {
  const { positions, total_positions } = await getMyPositions({ force: true });
  if (total_positions === 0) {
    await sendHTML(`🗂️ <b>Open Positions</b>\n\nBelum ada posisi terbuka. Saatnya cari peluang baru.`);
    return;
  }
  const lines = positions.map((p, i) => {
    const mood = positionMood(p);
    const pnlLine = (p.pnl_usd || 0) >= 0
      ? `📈 PnL: +$${formatUsd(p.pnl_usd)}`
      : `📉 PnL: -$${formatUsd(Math.abs(p.pnl_usd || 0))}`;
    return [
      `${i + 1}. ${mood} <b>${formatPositionName(p)}</b>`,
      `💼 Value: <b>$${formatUsd(p.total_value_usd)}</b>   💎 Fees: <b>$${formatUsd(p.unclaimed_fees_usd)}</b>`,
      `${pnlLine}   ⏳ Age: ${ageLabel(p.age_minutes)}`,
      `📍 Status: ${rangeLabel(p)}`,
    ].join("\n");
  });
  await sendHTML(`🗂️ <b>Open Positions</b> (${total_positions})\n\n${lines.join("\n\n")}\n\n<i>Tap tombol posisi di bawah untuk detail cepat.</i>`, {
    reply_markup: getPositionsMenuMarkup(positions),
  });
}

async function sendTelegramMemoryCard() {
  const { total, entries } = listMemory({ limit: 12 });
  if (total === 0) {
    await sendHTML(`🧠 <b>Agent Memory</b>\n\nBelum ada memory tersimpan.`);
    return;
  }
  const lines = entries.slice(-12).reverse().map((e) => {
    const pin = e.pinned ? "📌 " : "";
    return `${pin}[${e.type}] ${e.text.slice(0, 140)}\nUsed: ${e.usage_count || 0}x`;
  });
  await sendHTML(`🧠 <b>Agent Memory</b> (${total})\n\n${lines.join("\n\n")}`);
}

async function sendTelegramConfigCard() {
  const s = config.screening;
  const m = config.management;
  const r = config.risk;
  await sendHTML([
    `⚙️ <b>Settings Hub</b>`,
    `────────────────`,
    ``,
    `<b>Cycle Modes</b>`,
    `Management: ${formatScheduleMode(config.schedule.managementMode, config.schedule.managementIntervalMin)}`,
    `Screening: ${_screeningPausedForCapacity ? "paused (max positions)" : formatScheduleMode(config.schedule.screeningMode, config.schedule.screeningIntervalMin)}`,
    `Risk mode: ${riskModeLabel()} (${riskModeBrief()})`,
    `Mgmt feed: ${managementAlertModeLabel()}`,
    `Screen feed: ${screeningAlertModeLabel()}`,
    ``,
    `<b>Screening</b>`,
    `timeframe: ${s.timeframe} | category: ${s.category}`,
    `organic >= ${s.minOrganic} | holders >= ${s.minHolders}`,
    `fee/TVL >= ${s.minFeeActiveTvlRatio} | token fees >= ${s.minTokenFeesSol} SOL`,
    ``,
    `<b>Management</b>`,
    `deploy: ${m.deployAmountSol} SOL | TP: ${m.takeProfitFeePct}%`,
    `claim >= $${m.minClaimAmount} | OOR wait: ${m.outOfRangeWaitMinutes}m`,
    ``,
    `<b>Risk</b>`,
    `max positions: ${r.maxPositions} | max deploy: ${r.maxDeployAmount} SOL`,
    `────────────────`,
  ].join("\n"));
}

async function sendTelegramTradeSettingsCard() {
  const m = config.management;
  await sendHTML([
    `🎛️ <b>Trade Settings</b>`,
    `────────────────`,
    `🚀 Deploy amount: <b>${m.deployAmountSol} SOL</b>`,
    `🎯 Take profit: <b>${m.takeProfitFeePct}%</b>`,
    `💎 Claim threshold: <b>$${m.minClaimAmount}</b>`,
    ``,
    `Pilih preset dari tombol di bawah.`,
    `────────────────`,
  ].join("\n"), { reply_markup: getTradeSettingsMenuMarkup() });
}

async function sendTelegramRiskSettingsCard() {
  const r = config.risk;
  const mode = riskModeLabel();
  const safeBadge = mode === "safe" ? "✅ Safe active" : "Safe";
  const moderateBadge = mode === "moderate" ? "✅ Moderate active" : "Moderate";
  const degenBadge = mode === "degen" ? "✅ Degen active" : "Degen";
  await sendHTML([
    `🛡️ <b>Risk Settings</b>`,
    `────────────────`,
    `📚 Max positions: <b>${r.maxPositions}</b>`,
    `🏦 Max deploy amount: <b>${r.maxDeployAmount} SOL</b>`,
    `🔥 Risk mode: <b>${mode}</b>`,
    `🧠 Style: ${riskModeBrief()}`,
    `🧭 Modes: ${safeBadge} | ${moderateBadge} | ${degenBadge}`,
    ``,
    `Pilih batas maksimum posisi atau ganti mode risiko dari tombol di bawah.`,
    `────────────────`,
  ].join("\n"), { reply_markup: getRiskSettingsMenuMarkup() });
}

async function sendTelegramScheduleSettingsCard() {
  await sendHTML([
    `⏱️ <b>Schedule Settings</b>`,
    `────────────────`,
    `🤖 Management: <b>${formatScheduleMode(config.schedule.managementMode, config.schedule.managementIntervalMin)}</b>`,
    `🧭 Screening: <b>${formatScheduleMode(config.schedule.screeningMode, config.schedule.screeningIntervalMin)}</b>`,
    `🔕 Management auto-report: <b>${managementAlertModeLabel()}</b>`,
    `🚨 Screening auto-report: <b>${screeningAlertModeLabel()}</b>`,
    ``,
    `Mode manual = hanya jalan saat kamu tekan menu.`,
    `Mode 24/7 = background aktif terus, report lengkap tetap muncul saat kamu tekan tombol.`,
    `Auto alert hanya keluar untuk event penting seperti OOR, saldo kurang, atau deploy gagal.`,
    `────────────────`,
  ].join("\n"), { reply_markup: getScheduleMenuMarkup() });
}

async function sendTelegramPositionDetail(index) {
  const { positions } = await getMyPositions({ force: true });
  const idx = index - 1;
  if (idx < 0 || idx >= positions.length) {
    await sendMessage("Posisi tidak ditemukan.");
    return;
  }
  const pos = positions[idx];
  const tracked = getTrackedPosition(pos.position);
  const instruction = tracked?.instruction || pos.instruction || "none";
  const pnlLine = (pos.pnl_usd || 0) >= 0
    ? `📈 PnL: +$${formatUsd(pos.pnl_usd)}`
    : `📉 PnL: -$${formatUsd(Math.abs(pos.pnl_usd || 0))}`;
  await sendHTML([
    `${positionMood(pos)} <b>Position #${index}</b>`,
    `────────────────`,
    `🪙 <b>${formatPositionName(pos)}</b>`,
    `💼 Position Value: <b>$${formatUsd(pos.total_value_usd)}</b>`,
    `💎 Unclaimed Fees: <b>$${formatUsd(pos.unclaimed_fees_usd)}</b>`,
    `${pnlLine}`,
    `📍 Status: ${rangeLabel(pos)}`,
    `⏳ Age: ${ageLabel(pos.age_minutes)}`,
    `🧠 Instruction: ${instruction}`,
    `🔗 Position ID: <code>${pos.position}</code>`,
    `────────────────`,
  ].join("\n"), { reply_markup: getPositionActionMenuMarkup(index) });
}

function applyConfigPreset(changes, reason) {
  Object.entries(changes).forEach(([key, val]) => {
    if (key === "deployAmountSol" || key === "takeProfitFeePct" || key === "minClaimAmount") {
      config.management[key] = val;
    } else if (key === "maxPositions") {
      config.risk[key] = val;
    }
  });
  persistUserConfig(changes);
  addMemory(`Changed ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${reason}`, MemoryType.SELF_TUNED);
}

async function applySchedulePreset(kind, mode, interval = null) {
  if (kind === "management") {
    config.schedule.managementMode = mode;
    if (interval != null) config.schedule.managementIntervalMin = interval;
  } else {
    config.schedule.screeningMode = mode;
    if (interval != null) config.schedule.screeningIntervalMin = interval;
  }

  persistUserConfig({
    managementMode: config.schedule.managementMode,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningMode: config.schedule.screeningMode,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
  });
  if (cronStarted) startCronJobs();
  await sendTelegramConfigCard();
  await sendSettingsMenu(`Pengaturan ${kind} diperbarui ke ${formatScheduleMode(mode, interval ?? (kind === "management" ? config.schedule.managementIntervalMin : config.schedule.screeningIntervalMin))}.`);
}

function persistUserConfig(changes) {
  let current = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try {
      current = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    } catch {
      current = {};
    }
  }
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify({ ...current, ...changes }, null, 2));
}

function getRiskModePreset(mode) {
  if (mode === "degen") {
    return {
      riskMode: "degen",
      timeframe: "30m",
      maxVolatility: 12,
      maxPriceChangePct: 900,
      minOrganic: 60,
      minHolders: 200,
      takeProfitFeePct: 10,
      outOfRangeWaitMinutes: 15,
      managementIntervalMin: 5,
      screeningIntervalMin: 15,
    };
  }
  if (mode === "safe") {
    return {
      riskMode: "safe",
      timeframe: "24h",
      maxVolatility: 4,
      maxPriceChangePct: 120,
      minOrganic: 75,
      minHolders: 1000,
      takeProfitFeePct: 3,
      outOfRangeWaitMinutes: 60,
      managementIntervalMin: 15,
      screeningIntervalMin: 60,
    };
  }
  return {
    riskMode: "moderate",
    timeframe: "4h",
    maxVolatility: 8,
    maxPriceChangePct: 300,
    minOrganic: 65,
    minHolders: 500,
    takeProfitFeePct: 5,
    outOfRangeWaitMinutes: 30,
    managementIntervalMin: 10,
    screeningIntervalMin: 30,
  };
}

async function applyRiskModePreset(mode) {
  const preset = getRiskModePreset(mode);
  config.profile.riskMode = preset.riskMode;
  config.screening.timeframe = preset.timeframe;
  config.screening.maxVolatility = preset.maxVolatility;
  config.screening.maxPriceChangePct = preset.maxPriceChangePct;
  config.screening.minOrganic = preset.minOrganic;
  config.screening.minHolders = preset.minHolders;
  config.management.takeProfitFeePct = preset.takeProfitFeePct;
  config.management.outOfRangeWaitMinutes = preset.outOfRangeWaitMinutes;
  config.schedule.managementIntervalMin = preset.managementIntervalMin;
  config.schedule.screeningIntervalMin = preset.screeningIntervalMin;

  persistUserConfig(preset);
  if (cronStarted) startCronJobs();
  addMemory(`Changed riskMode=${mode}, timeframe=${preset.timeframe}, maxVolatility=${preset.maxVolatility}, maxPriceChangePct=${preset.maxPriceChangePct} — Telegram risk mode preset`, MemoryType.SELF_TUNED);
  await sendTelegramRiskSettingsCard();
  await sendSettingsMenu(`Risk mode diubah ke ${mode}. Screening dan management preset ikut disesuaikan.`);
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun  = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions(),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => {});
  syncTelegramCommands().catch(() => {});

  // Telegram bot
  startPolling(async (text) => {
    if (_managementBusy || _screeningBusy || busy) {
      sendMessage("Agent is busy right now — try again in a moment.").catch(() => {});
      return;
    }

    const normalized = text.trim();
    if ([TELEGRAM_LABELS.MENU, "/menu", "/start", "/home"].includes(normalized)) {
      await sendMainMenu();
      return;
    }

    if ([TELEGRAM_LABELS.HELP, "/help"].includes(normalized)) {
      await sendHTML(
        `🧭 <b>Meridian Command Menu</b>\n\n` +
        `<code>/home</code> buka menu utama\n` +
        `<code>/status</code> ringkasan wallet dan cycle\n` +
        `<code>/positions</code> daftar posisi aktif\n` +
        `<code>/manage</code> lihat report management terakhir, atau jalankan kalau mode manual\n` +
        `<code>/screen</code> lihat report screening terakhir, atau jalankan kalau mode manual\n` +
        `<code>/briefing</code> tampilkan morning briefing\n` +
        `<code>/settings</code> ubah manual/interval/24-7\n\n` +
        `Klik tombol <b>Menu</b> di kiri bawah Telegram untuk melihat daftar command seperti contoh yang kamu mau.`
      );
      return;
    }

    if ([TELEGRAM_LABELS.SETTINGS, "/settings"].includes(normalized)) {
      await sendTelegramConfigCard();
      await sendSettingsMenu();
      return;
    }

    if (normalized === TELEGRAM_LABELS.SETTINGS_SCHEDULE) {
      await sendTelegramScheduleSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.SETTINGS_TRADE) {
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.SETTINGS_RISK) {
      await sendTelegramRiskSettingsCard();
      return;
    }

    if (normalized === TELEGRAM_LABELS.BACK) {
      await sendMainMenu();
      return;
    }
    if (normalized === TELEGRAM_LABELS.POSITIONS_BACK) {
      await sendTelegramPositionsCard();
      return;
    }

    if (normalized === TELEGRAM_LABELS.MGMT_MANUAL) {
      await applySchedulePreset("management", "manual");
      return;
    }
    if (normalized === TELEGRAM_LABELS.MGMT_247) {
      await applySchedulePreset("management", "nonstop");
      return;
    }
    if (normalized === TELEGRAM_LABELS.MGMT_15M) {
      await applySchedulePreset("management", "interval", 15);
      return;
    }
    if (normalized === TELEGRAM_LABELS.MGMT_30M) {
      await applySchedulePreset("management", "interval", 30);
      return;
    }
    if (normalized === TELEGRAM_LABELS.SCREEN_MANUAL) {
      await applySchedulePreset("screening", "manual");
      return;
    }
    if (normalized === TELEGRAM_LABELS.SCREEN_247) {
      await applySchedulePreset("screening", "nonstop");
      return;
    }
    if (normalized === TELEGRAM_LABELS.SCREEN_30M) {
      await applySchedulePreset("screening", "interval", 30);
      return;
    }
    if (normalized === TELEGRAM_LABELS.SCREEN_60M) {
      await applySchedulePreset("screening", "interval", 60);
      return;
    }
    if (normalized === TELEGRAM_LABELS.DEPLOY_05) {
      applyConfigPreset({ deployAmountSol: 0.5 }, "Telegram trade preset");
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.DEPLOY_10) {
      applyConfigPreset({ deployAmountSol: 1 }, "Telegram trade preset");
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.DEPLOY_20) {
      applyConfigPreset({ deployAmountSol: 2 }, "Telegram trade preset");
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.TP_3) {
      applyConfigPreset({ takeProfitFeePct: 3 }, "Telegram trade preset");
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.TP_5) {
      applyConfigPreset({ takeProfitFeePct: 5 }, "Telegram trade preset");
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.TP_8) {
      applyConfigPreset({ takeProfitFeePct: 8 }, "Telegram trade preset");
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.CLAIM_5) {
      applyConfigPreset({ minClaimAmount: 5 }, "Telegram trade preset");
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.CLAIM_10) {
      applyConfigPreset({ minClaimAmount: 10 }, "Telegram trade preset");
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.CLAIM_20) {
      applyConfigPreset({ minClaimAmount: 20 }, "Telegram trade preset");
      await sendTelegramTradeSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.MAXPOS_1) {
      applyConfigPreset({ maxPositions: 1 }, "Telegram risk preset");
      await sendTelegramRiskSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.MAXPOS_3) {
      applyConfigPreset({ maxPositions: 3 }, "Telegram risk preset");
      await sendTelegramRiskSettingsCard();
      return;
    }
    if (normalized === TELEGRAM_LABELS.MAXPOS_5) {
      applyConfigPreset({ maxPositions: 5 }, "Telegram risk preset");
      await sendTelegramRiskSettingsCard();
      return;
    }
    if (isRiskModeButton(normalized, "safe")) {
      await applyRiskModePreset("safe");
      return;
    }
    if (isRiskModeButton(normalized, "moderate")) {
      await applyRiskModePreset("moderate");
      return;
    }
    if (isRiskModeButton(normalized, "degen")) {
      await applyRiskModePreset("degen");
      return;
    }

    const positionButtonMatch = normalized.match(/^(\d+)\.\s+/);
    if (positionButtonMatch) {
      await sendTelegramPositionDetail(parseInt(positionButtonMatch[1], 10));
      return;
    }

    const positionCloseMatch = normalized.match(/^Close\s+#(\d+)$/i);
    if (positionCloseMatch) {
      try {
        const idx = parseInt(positionCloseMatch[1], 10) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Posisi tidak ditemukan."); return; }
        const pos = positions[idx];
        await sendMessage(`Closing ${pos.pair}...`);
        const result = await closePosition({ position_address: pos.position, pool_address: pos.pool });
        if (result.success) {
          const tx = result.txs?.[0] || result.tx || null;
          const txLink = tx ? `https://solscan.io/tx/${tx}` : null;
          const pnlLink = tx ? `https://www.metlex.io/pnl2/${tx}` : null;
          const poolLink = pos.pool ? `https://app.meteora.ag/dlmm/${pos.pool}` : null;
          await sendHTML([
            `🔒 <b>Closed ${escapeHtml(pos.pair)}</b>`,
            `━━━━━━━━━━━━━━`,
            `📊 <b>PnL:</b> $${escapeHtml(result.pnl_usd ?? "?")}`,
            txLink ? `🔗 <a href="${txLink}">View Close Tx</a>` : null,
            pnlLink ? `📈 <a href="${pnlLink}">Open PnL Card</a>` : null,
            poolLink ? `🌊 <a href="${poolLink}">Open Pool</a>` : null,
            tx ? `🔹 <b>Tx ID:</b> <code>${shortHash(tx)}</code>` : null,
          ].filter(Boolean).join("\n"));
        } else {
          await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
        }
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    const holdButtonMatch = normalized.match(/^Hold\s+#(\d+)$/i);
    if (holdButtonMatch) {
      try {
        const idx = parseInt(holdButtonMatch[1], 10) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Posisi tidak ditemukan."); return; }
        const pos = positions[idx];
        setPositionInstruction(pos.position, "Hold until manual review");
        await sendTelegramPositionDetail(idx + 1);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    const tpButtonMatch = normalized.match(/^TP5\s+#(\d+)$/i);
    if (tpButtonMatch) {
      try {
        const idx = parseInt(tpButtonMatch[1], 10) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Posisi tidak ditemukan."); return; }
        const pos = positions[idx];
        setPositionInstruction(pos.position, "Close at 5% profit");
        await sendTelegramPositionDetail(idx + 1);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    if (normalized === TELEGRAM_LABELS.BRIEFING || normalized === "/briefing") {
      try {
        const briefing = await generateBriefing();
        await sendHTML(briefing);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (normalized === TELEGRAM_LABELS.POSITIONS || normalized === "/positions") {
      try { await sendTelegramPositionsCard(); }
      catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    if (normalized === TELEGRAM_LABELS.STATUS || normalized === "/status") {
      try { await sendTelegramStatusCard(); }
      catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    if (normalized === TELEGRAM_LABELS.MANAGEMENT || normalized === "/manage") {
      try {
        if (config.schedule.managementMode !== "manual" && await sendLastCycleReport("management")) {
          return;
        }
        await sendHTML(`🔄 <b>Management Cycle</b>\n\nMenjalankan management sekali sekarang...`);
        _managementBusy = true;
        timers.managementLastRun = Date.now();
        const report = await runManagementCycle({ delivery: "silent" });
        if (report) await sendHTML(formatManagementTelegramReport(report) || `🔄 <b>Management Cycle</b>\n\n${escapeHtml(report)}`);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      } finally {
        _managementBusy = false;
      }
      return;
    }

    if (normalized === TELEGRAM_LABELS.SCREENING || normalized === "/screen") {
      try {
        if (config.schedule.screeningMode !== "manual" && await sendLastCycleReport("screening")) {
          return;
        }
        await sendHTML(`🔍 <b>Screening Cycle</b>\n\nMenjalankan screening sekali sekarang...`);
        const report = await runScreeningCycle({ delivery: "silent" });
        if (report) await sendHTML(formatScreeningTelegramReport(report) || `🔍 <b>Screening Cycle</b>\n\n${escapeHtml(report)}`);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      try {
        const idx = parseInt(closeMatch[1]) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage(`Invalid number. Use /positions first.`); return; }
        const pos = positions[idx];
        await sendMessage(`Closing ${pos.pair}...`);
        const result = await closePosition({ position_address: pos.position, pool_address: pos.pool });
        if (result.success) {
          const tx = result.txs?.[0] || result.tx || null;
          const txLink = tx ? `https://solscan.io/tx/${tx}` : null;
          const pnlLink = tx ? `https://www.metlex.io/pnl2/${tx}` : null;
          const poolLink = pos.pool ? `https://app.meteora.ag/dlmm/${pos.pool}` : null;
          await sendHTML([
            `🔒 <b>Closed ${escapeHtml(pos.pair)}</b>`,
            `📊 <b>PnL:</b> $${escapeHtml(result.pnl_usd ?? "?")}`,
            txLink ? `🔗 <a href="${txLink}">View Close Tx</a>` : null,
            pnlLink ? `📈 <a href="${pnlLink}">Open PnL Card</a>` : null,
            poolLink ? `🌊 <a href="${poolLink}">Open Pool</a>` : null,
          ].filter(Boolean).join("\n"));
        } else {
          await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
        }
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
    if (setMatch) {
      try {
        const idx = parseInt(setMatch[1]) - 1;
        const note = setMatch[2].trim();
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage(`Invalid number. Use /positions first.`); return; }
        const pos = positions[idx];
        setPositionInstruction(pos.position, note);
        await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    // ── /memory ─────────────────────────────────────────────────────
    if (normalized === TELEGRAM_LABELS.MEMORY || normalized === "/memory" || normalized.startsWith("/memory ")) {
      try {
        const addMatch = normalized.match(/^\/memory add\s+(.+)$/i);
        if (addMatch) {
          const memText = addMatch[1].trim();
          addMemory(memText, MemoryType.USER_TAUGHT, { pinned: false });
          await sendMessage(`✅ Memory saved:\n"${memText}"`);
          return;
        }
        await sendTelegramMemoryCard();
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    // ── /lessons ─────────────────────────────────────────────────────
    if (text === "/lessons" || text.startsWith("/lessons ")) {
      try {
        const roleMatch = text.match(/^\/lessons\s+(SCREENER|MANAGER|GENERAL)$/i);
        const role = roleMatch ? roleMatch[1].toUpperCase() : null;
        const { total, lessons } = listLessons({ role, limit: 15 });
        if (total === 0) {
          await sendMessage("No lessons yet.");
          return;
        }
        const lines = lessons.map((l) => {
          const pin = l.pinned ? "📌 " : "";
          return `${pin}[${l.outcome.toUpperCase()}] ${l.rule.slice(0, 120)}`;
        });
        await sendHTML(`📚 <b>Lessons</b> (${total} total${role ? `, ${role}` : ""})\n\n${lines.join("\n")}`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    // ── /config ──────────────────────────────────────────────────────
    if (normalized === "/config") {
      try {
        await sendTelegramConfigCard();
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    busy = true;
    try {
      log("telegram", `Incoming: ${normalized}`);
      sendTyping().catch(() => {}); // show "typing..." indicator
      captureOperatorPreference(normalized, "telegram");
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(normalized);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(normalized);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const model = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
      const { content } = await agentLoop(normalized, config.llm.maxSteps, sessionHistory, agentRole, model);
      appendHistory(normalized, content);
      await sendMessage(content);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  });

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlersPct:       ${s.maxBundlersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel);
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => {});
  (async () => {
    try {
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL. 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
