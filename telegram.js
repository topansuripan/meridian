import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;

export const TELEGRAM_LABELS = {
  MENU: "Menu",
  STATUS: "Status",
  POSITIONS: "Positions",
  BRIEFING: "Briefing",
  DAILY: "Daily",
  MEMORY: "Memory",
  SETTINGS: "Settings",
  HELP: "Help",
  SETTINGS_SCHEDULE: "Schedule",
  SETTINGS_TRADE: "Trade",
  SETTINGS_RISK: "Risk",
  MGMT_MANUAL: "Mgmt Manual",
  MGMT_247: "Mgmt 24/7",
  MGMT_15M: "Mgmt 15m",
  MGMT_30M: "Mgmt 30m",
  SCREEN_MANUAL: "Screen Manual",
  SCREEN_247: "Screen 24/7",
  SCREEN_30M: "Screen 30m",
  SCREEN_60M: "Screen 60m",
  DEPLOY_05: "Deploy 3.0",
  DEPLOY_10: "Deploy 3.5",
  DEPLOY_20: "Deploy 4.0",
  TP_3: "TP 3%",
  TP_5: "TP 5%",
  TP_8: "TP 8%",
  CLAIM_5: "Claim $5",
  CLAIM_10: "Claim $10",
  CLAIM_20: "Claim $20",
  MAXPOS_1: "MaxPos 1",
  MAXPOS_3: "MaxPos 3",
  MAXPOS_5: "MaxPos 5",
  POSITIONS_BACK: "Back to Positions",
  BACK: "Back to Menu",
};

const BOT_COMMANDS = [
  { command: "home", description: "open the main control menu" },
  { command: "status", description: "show wallet and cycle status" },
  { command: "positions", description: "show open positions" },
  { command: "briefing", description: "show the morning briefing" },
  { command: "daily", description: "show today's realized summary" },
  { command: "memory", description: "show agent memory" },
  { command: "settings", description: "open settings menu" },
  { command: "help", description: "show command help" },
];

function keyboard(rows) {
  return {
    keyboard: rows.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    input_field_placeholder: "Choose a menu or type a request",
  };
}

export function getMainMenuMarkup() {
  return keyboard([
    [TELEGRAM_LABELS.STATUS, TELEGRAM_LABELS.POSITIONS],
    [TELEGRAM_LABELS.BRIEFING, TELEGRAM_LABELS.DAILY],
    [TELEGRAM_LABELS.MEMORY, TELEGRAM_LABELS.SETTINGS],
    [TELEGRAM_LABELS.HELP],
  ]);
}

export function getSettingsMenuMarkup() {
  return keyboard([
    [TELEGRAM_LABELS.SETTINGS_SCHEDULE, TELEGRAM_LABELS.SETTINGS_TRADE, TELEGRAM_LABELS.SETTINGS_RISK],
    [TELEGRAM_LABELS.BACK],
  ]);
}

export function getScheduleMenuMarkup() {
  return keyboard([
    [TELEGRAM_LABELS.MGMT_MANUAL, TELEGRAM_LABELS.MGMT_247, TELEGRAM_LABELS.MGMT_15M, TELEGRAM_LABELS.MGMT_30M],
    [TELEGRAM_LABELS.SCREEN_MANUAL, TELEGRAM_LABELS.SCREEN_247, TELEGRAM_LABELS.SCREEN_30M, TELEGRAM_LABELS.SCREEN_60M],
    [TELEGRAM_LABELS.SETTINGS, TELEGRAM_LABELS.BACK],
  ]);
}

export function getTradeSettingsMenuMarkup() {
  return keyboard([
    [TELEGRAM_LABELS.DEPLOY_05, TELEGRAM_LABELS.DEPLOY_10, TELEGRAM_LABELS.DEPLOY_20],
    [TELEGRAM_LABELS.TP_3, TELEGRAM_LABELS.TP_5, TELEGRAM_LABELS.TP_8],
    [TELEGRAM_LABELS.CLAIM_5, TELEGRAM_LABELS.CLAIM_10, TELEGRAM_LABELS.CLAIM_20],
    [TELEGRAM_LABELS.SETTINGS, TELEGRAM_LABELS.BACK],
  ]);
}

export function getRiskSettingsMenuMarkup() {
  return keyboard([
    [TELEGRAM_LABELS.MAXPOS_1, TELEGRAM_LABELS.MAXPOS_3, TELEGRAM_LABELS.MAXPOS_5],
    [TELEGRAM_LABELS.SETTINGS, TELEGRAM_LABELS.BACK],
  ]);
}

export function getPositionsMenuMarkup(positions = []) {
  const rows = [];
  for (let i = 0; i < positions.length; i += 2) {
    rows.push(
      positions.slice(i, i + 2).map((p, offset) => {
        const idx = i + offset + 1;
        const label = `${idx}. ${(p.pair || "Position").slice(0, 18)}`;
        return label;
      })
    );
  }
  rows.push([TELEGRAM_LABELS.POSITIONS_BACK, TELEGRAM_LABELS.BACK]);
  return keyboard(rows);
}

export function getPositionActionMenuMarkup(index) {
  return keyboard([
    [`Close #${index}`, `Hold #${index}`],
    [`TP5 #${index}`, TELEGRAM_LABELS.POSITIONS_BACK],
    [TELEGRAM_LABELS.BACK],
  ]);
}

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch { /**/ }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

export function removeKeyboardMarkup() {
  return { remove_keyboard: true };
}

export async function sendMessage(text, options = {}) {
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4096),
        reply_markup: options.reply_markup,
        parse_mode: options.parse_mode,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendMessage ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendMessage failed: ${e.message}`);
  }
}

/** Send a "typing" chat action to show the bot is processing. */
export async function sendTyping() {
  if (!TOKEN || !chatId) return;
  try {
    await fetch(`${BASE}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch { /* non-critical */ }
}

export async function sendHTML(html, options = {}) {
  if (!TOKEN || !chatId) return;
  const CHUNK = 4096;
  const text = html;
  // Split into chunks at newline boundaries to avoid breaking HTML tags mid-chunk
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK) {
      chunks.push(remaining);
      break;
    }
    // Find last newline before the chunk limit
    const cut = remaining.lastIndexOf("\n", CHUNK);
    const splitAt = cut > 0 ? cut : CHUNK;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (const chunk of chunks) {
    try {
      const res = await fetch(`${BASE}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
          reply_markup: options.reply_markup,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        log("telegram_error", `sendHTML ${res.status}: ${err.slice(0, 100)}`);
      }
    } catch (e) {
      log("telegram_error", `sendHTML failed: ${e.message}`);
    }
  }
}

/** Notify about an agent self-tuning event. */
export async function notifyConfigChange(key, oldVal, newVal, reason = "") {
  await sendHTML(
    `🔧 <b>Self-Tuned</b>\n` +
    `<code>${key}</code>: ${oldVal} → ${newVal}\n` +
    (reason ? `Reason: ${reason}` : "")
  );
}

export async function sendMainMenu(text = "Menu siap. Pilih aksi di bawah atau ketik pesan bebas.") {
  await sendMessage(text, { reply_markup: removeKeyboardMarkup() });
}

export async function sendSettingsMenu(text = "Atur jadwal agent dari tombol di bawah. Mode manual artinya hanya jalan saat kamu tekan menu.") {
  await sendMessage(text, { reply_markup: getSettingsMenuMarkup() });
}

export async function syncTelegramCommands() {
  if (!TOKEN) return;

  try {
    await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });

    if (chatId) {
      await fetch(`${BASE}/setChatMenuButton`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          menu_button: { type: "commands" },
        }),
      });
    }
  } catch (e) {
    log("telegram_error", `syncTelegramCommands failed: ${e.message}`);
  }
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const incomingChatId = String(msg.chat.id);

        // Auto-register first sender as the owner
        if (!chatId) {
          chatId = incomingChatId;
          saveChatId(chatId);
          log("telegram", `Registered chat ID: ${chatId}`);
          await syncTelegramCommands();
          await sendMessage("Connected! I'm your LP agent. Ask me anything or use commands like /status.");
        }

        // Only accept messages from the registered chat
        if (incomingChatId !== chatId) continue;

        await onMessage(msg.text, msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
function solscanTxLink(tx) {
  return tx ? `https://solscan.io/tx/${tx}` : null;
}

function meteoraPoolLink(poolAddress) {
  return poolAddress ? `https://app.meteora.ag/dlmm/${poolAddress}` : null;
}

function metlexPnlLink(tx) {
  return tx ? `https://www.metlex.io/pnl2/${tx}` : null;
}

function shortCode(value, head = 8, tail = 4) {
  const text = String(value || "");
  if (!text) return "-";
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatPrice(value) {
  if (value == null) return "?";
  return value < 0.0001 ? value.toExponential(3) : value.toFixed(6);
}

export async function notifyDeploy({ pair, amountSol, position, tx, poolAddress, priceRange, binStep, baseFee, thesis }) {
  const txLink = solscanTxLink(tx);
  const poolLink = meteoraPoolLink(poolAddress);
  await sendHTML([
    `✅ <b>Deployed ${escapeHtml(pair)}</b>`,
    `━━━━━━━━━━━━━━`,
    `💰 <b>Amount:</b> ${amountSol} SOL`,
    priceRange ? `🎯 <b>Range:</b> ${formatPrice(priceRange.min)} - ${formatPrice(priceRange.max)}` : null,
    (binStep || baseFee != null) ? `⚙️ <b>Setup:</b> Bin ${binStep ?? "?"} | Fee ${baseFee != null ? `${baseFee}%` : "?"}` : null,
    thesis ? `🧠 <b>Thesis:</b> ${escapeHtml(thesis)}` : null,
    txLink || poolLink ? "" : null,
    txLink ? `🔗 <a href="${txLink}">View Tx</a>` : null,
    poolLink ? `🌊 <a href="${poolLink}">Open Pool</a>` : null,
    `🧾 <b>Position ID:</b> <code>${shortCode(position)}</code>`,
    tx ? `🔹 <b>Tx ID:</b> <code>${shortCode(tx, 10, 6)}</code>` : null,
  ].filter(Boolean).join("\n"));
}

export async function notifyClose({ pair, pnlUsd, pnlPct, tx, poolAddress }) {
  const sign = pnlUsd >= 0 ? "+" : "";
  const pnlLink = metlexPnlLink(tx);
  await sendHTML([
    `🔒 <b>Closed ${escapeHtml(pair)}</b>`,
    `━━━━━━━━━━━━━━`,
    `📊 <b>PnL:</b> ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`,
    pnlLink ? `📈 <a href="${pnlLink}">Open PnL Card</a>` : null,
  ].filter(Boolean).join("\n"));
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  const txLink = solscanTxLink(tx);
  await sendHTML(
    [
      `🔄 <b>Swap Executed</b>`,
      `💱 <b>${inputSymbol}</b> → <b>${outputSymbol}</b>`,
      `📥 In: ${amountIn ?? "?"} | 📤 Out: ${amountOut ?? "?"}`,
      txLink ? `🔗 <a href="${txLink}">View Tx</a>` : null,
    ].filter(Boolean).join("\n")
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  await sendHTML(
    `⚠️ <b>${pair} Out of Range</b>\n` +
    `🕒 Been out of range for <b>${minutesOOR}m</b>\n` +
    `👀 Marked for management attention`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
