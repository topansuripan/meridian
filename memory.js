/**
 * Agent Memory System
 *
 * Persistent memory for the agent — separate from lessons.json.
 * Entries have a type that describes how they were created:
 *   [SELF-TUNED]   — agent changed a config value and recorded why
 *   [USER-TAUGHT]  — operator explicitly told the agent something
 *   [OBSERVED]     — agent observed a market pattern or behaviour
 *   [EVOLUTION]    — auto-evolved threshold or parameter
 *
 * Memory is injected into every system prompt so the agent always
 * has context about its own history of decisions and preferences.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, "memory.json");

const MAX_MEMORY_ENTRIES = 200;
const PROMPT_INJECT_CAP = 15; // max entries in system prompt

// ─── Types ──────────────────────────────────────────────
export const MemoryType = {
  SELF_TUNED:  "SELF-TUNED",
  USER_TAUGHT: "USER-TAUGHT",
  OBSERVED:    "OBSERVED",
  EVOLUTION:   "EVOLUTION",
};

// ─── Storage ─────────────────────────────────────────────

function load() {
  if (!fs.existsSync(MEMORY_FILE)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function save(data) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}

// ─── Public API ─────────────────────────────────────────

/**
 * Add a memory entry.
 *
 * @param {string} text           - The memory text
 * @param {string} [type]         - MemoryType value (default OBSERVED)
 * @param {Object} [opts]
 * @param {boolean} [opts.pinned] - Pinned entries always appear in prompt
 * @param {string}  [opts.role]   - "SCREENER" | "MANAGER" | "GENERAL" | null (all)
 * @returns {Object} The created entry
 */
export function addMemory(text, type = MemoryType.OBSERVED, { pinned = false, role = null } = {}) {
  const data = load();
  const normalized = String(text).trim().replace(/\s+/g, " ").slice(0, 500);
  const now = new Date().toISOString();

  const existing = data.entries.find(
    (e) =>
      e.type === (type || MemoryType.OBSERVED) &&
      (e.role || null) === (role || null) &&
      (e.text || "").trim().toLowerCase() === normalized.toLowerCase()
  );

  if (existing) {
    existing.pinned = existing.pinned || !!pinned;
    existing.last_reinforced_at = now;
    existing.reinforcement_count = (existing.reinforcement_count || 1) + 1;
    save(data);
    log("memory", `[${existing.type}] reinforced ${existing.text.slice(0, 80)}`);
    return existing;
  }

  const entry = {
    id: Date.now(),
    type: type || MemoryType.OBSERVED,
    text: normalized,
    pinned: !!pinned,
    role: role || null,
    created_at: now,
    last_reinforced_at: now,
    reinforcement_count: 1,
    usage_count: 0,
    last_used_at: null,
  };

  data.entries.push(entry);

  // Prune oldest unpinned entries if we exceed the cap
  const unpinned = data.entries.filter((e) => !e.pinned);
  if (unpinned.length > MAX_MEMORY_ENTRIES) {
    const toRemove = unpinned.length - MAX_MEMORY_ENTRIES;
    let removed = 0;
    data.entries = data.entries.filter((e) => {
      if (!e.pinned && removed < toRemove) { removed++; return false; }
      return true;
    });
  }

  save(data);
  log("memory", `[${entry.type}] ${entry.text.slice(0, 80)}`);
  return entry;
}

/**
 * Get all memory entries — optionally filtered.
 */
export function listMemory({ type = null, role = null, pinned = null, limit = 30 } = {}) {
  const data = load();
  let entries = [...data.entries];

  if (type)             entries = entries.filter((e) => e.type === type);
  if (role)             entries = entries.filter((e) => !e.role || e.role === role);
  if (pinned !== null)  entries = entries.filter((e) => !!e.pinned === pinned);

  return {
    total: entries.length,
    entries: entries.slice(-limit).map((e) => ({
      id: e.id,
      type: e.type,
      text: e.text.slice(0, 200),
      pinned: !!e.pinned,
      role: e.role || "all",
      created_at: e.created_at?.slice(0, 16),
      reinforcement_count: e.reinforcement_count || 1,
      usage_count: e.usage_count || 0,
      last_used_at: e.last_used_at?.slice(0, 16) || null,
    })),
  };
}

/**
 * Pin/unpin an entry by id.
 */
export function pinMemory(id, pinned = true) {
  const data = load();
  const entry = data.entries.find((e) => e.id === id);
  if (!entry) return { found: false };
  entry.pinned = pinned;
  save(data);
  return { found: true, id, pinned };
}

/**
 * Remove a memory entry by id.
 */
export function removeMemory(id) {
  const data = load();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.id !== id);
  save(data);
  return before - data.entries.length;
}

/**
 * Clear all memory (keeps pinned by default unless force=true).
 */
export function clearMemory({ force = false } = {}) {
  const data = load();
  const before = data.entries.length;
  data.entries = force ? [] : data.entries.filter((e) => e.pinned);
  save(data);
  return before - data.entries.length;
}

/**
 * Get recent [SELF-TUNED] or [EVOLUTION] entries within the last N hours.
 * Used by briefing.js to populate "Lessons Learned" with self-tunes.
 */
export function getRecentSelfTuned(hours = 24) {
  const data = load();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return data.entries.filter(
    (e) =>
      (e.type === MemoryType.SELF_TUNED || e.type === MemoryType.EVOLUTION) &&
      e.created_at >= cutoff
  );
}

/**
 * Format memory for injection into the system prompt.
 * Three tiers: pinned → role-matched → recent.
 *
 * @param {string} [agentType] - "SCREENER" | "MANAGER" | "GENERAL"
 * @returns {string|null}
 */
export function getMemoryForPrompt(agentType = "GENERAL") {
  const data = load();
  if (data.entries.length === 0) return null;

  const allEntries = data.entries;

  // Tier 1: Pinned (respects role filter)
  const pinned = allEntries
    .filter((e) => e.pinned && (!e.role || e.role === agentType || agentType === "GENERAL"))
    .slice(-5);

  const usedIds = new Set(pinned.map((e) => e.id));

  // Tier 2: Role-matched (recent first)
  const roleMatched = allEntries
    .filter((e) => {
      if (usedIds.has(e.id)) return false;
      return !e.role || e.role === agentType || agentType === "GENERAL";
    })
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    .slice(0, 6);

  roleMatched.forEach((e) => usedIds.add(e.id));

  // Tier 3: Recent fill
  const budget = PROMPT_INJECT_CAP - pinned.length - roleMatched.length;
  const recent = budget > 0
    ? allEntries
        .filter((e) => !usedIds.has(e.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, budget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  touchMemories(selected.map((e) => e.id));

  const lines = selected.map((e) => {
    const date = e.created_at ? e.created_at.slice(0, 16).replace("T", " ") : "?";
    const pin = e.pinned ? "📌 " : "";
    return `${pin}[${e.type}] [${date}] ${e.text}`;
  });

  return lines.join("\n");
}

function touchMemories(ids) {
  if (!ids?.length) return;
  const data = load();
  const now = new Date().toISOString();
  let changed = false;

  for (const entry of data.entries) {
    if (!ids.includes(entry.id)) continue;
    entry.usage_count = (entry.usage_count || 0) + 1;
    entry.last_used_at = now;
    changed = true;
  }

  if (changed) save(data);
}
