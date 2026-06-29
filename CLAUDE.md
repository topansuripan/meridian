# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| maxPump5mPct / maxPump15mPct / pumpLookbackHours | screening | 20 / 30 / 2 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 2 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | management=`MiniMax-M2.7`, screening=`MiniMax-M2.7`, general=`MiniMax-M2.7` |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be a positive finite number when provided; fresh pool detail with volatility 0/null is rejected
- Total range must be at least `max(35, minBinsBelow)` bins; 1-bin/tiny deploys are refused
- Position count must be below the per-type cap (force-fresh scan, no cache): degen deploys count only degen positions against `config.degen.maxPositions`; normal deploys count only normal positions against `config.risk.maxPositions`. The two caps are independent — e.g. `risk.maxPositions=2` + `degen.maxPositions=2` allows 2 normal + 2 degen simultaneously
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- `amount_x > 0` is rejected. Deploys are single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates
- Recent-pump guard (NORMAL only): refuses deploy if the pool's last `pumpLookbackHours` (2h) of 5m candles contain a single candle that rose ≥ `maxPump5mPct` (20%) or a 15m (3-candle) window that rose ≥ `maxPump15mPct` (30%). Data: Meteora 5m OHLCV (`fetchPoolOhlcv`/`detectRecentPump` in screening.js). Wash/parabolic tell — calibrated to the ALON loss (2026-06-29: +24.5% 5m candle one bar before entry → −7.53% stop). Degen exempt; missing data never blocks. Enforced at the deploy gate (executor.js) and as a screening filter in `getTopCandidates` (degen opts out via `buildDegenScreeningOverrides`).

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp is `[35, 69]`
- `volatility <= 0`, null, or non-finite → skip/refuse deploy
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |
| `/spectate on\|off` | Toggle watch-only mode (cycles keep running, no actions); bare `/spectate` reports state |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default per-role models: `management=MiniMax-M2.7`, `screening=MiniMax-M2.7`, `general=MiniMax-M2.7` unless `process.env.LLM_MODEL` overrides them
- Fallback on transient provider errors: retry the same MiniMax model unless `LLM_FALLBACK_MODEL` is explicitly set
- Legacy per-role overrides still exist in `user-config.json`, but the preferred runtime default is `LLM_MODEL` in `.env`
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **Known issue**: `evolveThresholds()` references `maxVolatility` and `minFeeTvlRatio` but config.js uses `minFeeActiveTvlRatio` and has no `maxVolatility` key — the evolution of these keys is a no-op

---

## HiveMind

Agent Meridian HiveMind sync is handled by `hivemind.js`. It uses built-in Agent Meridian defaults unless overridden by config or env.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `LLM_API_KEY` | Yes | MiniMax or other OpenAI-compatible LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## VPS Deployment

- **Host**: `root@43.133.133.150`
- **Path**: `/root/meridian`
- **Branch**: `feature/degen-mode`
- **Process manager**: PM2 (process name: `meridian`)
- **Deploy workflow**: `git push origin feature/degen-mode` locally → `ssh root@43.133.133.150 "cd ~/meridian && git pull origin feature/degen-mode && npm install && pm2 restart meridian"`
- **Logs**: `pm2 logs meridian --lines 50 --nostream`
- **Config**: `/root/meridian/user-config.json` (not in git, edit directly on VPS)

---

## Operational Details

- **Wallet**: `BeEGreU2nwr8bXmrsi1Tf8ALZbVWP9VomfeaEMDLmSYg`
- **LLM Provider**: MiniMax-M2.7-highspeed via `https://ai.sumopod.com/v1`
- **Agent Meridian API**: `https://api.agentmeridian.xyz/api` (relay for pool discovery, PnL, top LP, study)
- **HiveMind URL**: `https://api.agentmeridian.xyz`
- **Discord Signals**: enabled, mode `merge` (merges Discord signal candidates into screening pipeline)

### VPS Config (user-config.json, not in git)

Key non-default values on VPS:
- `publicApiKey`: `"bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz"` (Agent Meridian relay key)
- `agentMeridianApiUrl`: `"https://api.agentmeridian.xyz/api"`
- `lpAgentRelayEnabled`: `true`
- `hiveMindUrl`: `"https://api.agentmeridian.xyz"`
- `hiveMindApiKey`: `"hm_8f3c7d1b4a6e92c5f0d8a3b7c1e4f9a2b6d7c8e1f3a5b9d2c4e6f8a1b3d5c7"`
- `useDiscordSignals`: `true`
- `discordSignalMode`: `"merge"`

---

## Safety Checks Added (May 2026)

### Mint/Freeze Authority Check
- `getTokenAudit(mint)` in `token.js` checks both top-level `mintAuthority`/`freezeAuthority` fields AND `audit.mintAuthorityDisabled`/`audit.freezeAuthorityDisabled`
- Token-2022 tokens may omit `audit` sub-fields; top-level fields are always present when authority is active
- Enforced in `executor.js runSafetyChecks()` — blocks deploy if token is mintable or freezable
- Controlled by `config.screening.blockMintableTokens` (default: true)

### Resolved Base Mint (CA vs Symbol Fix)
- LLM sometimes passes token symbol (e.g. "ANDURIL") instead of actual CA in `args.base_mint`
- `validateDeployPoolThresholds()` now extracts real CA from pool discovery data: `detail?.token_x?.address || detail?.base_token_address`
- Returns `resolvedBaseMint` which is used by ALL downstream safety checks (mint/freeze, duplicate token, Saturday rule, cooldown)
- `dlmm.js` deploy return now includes `base_mint: pool.lbPair.tokenXMint.toString()` for Telegram notifications

### Deploy Failure Cooldown
- `setDeployFailureCooldown()` in `pool-memory.js` sets 2-hour cooldown on both pool address AND base mint token when deploy is blocked
- Prevents infinite re-screening of pools that fail safety checks
- Screening already checks `isPoolOnCooldown()` and `isBaseMintOnCooldown()` before presenting candidates

### Pool Detail API Consistency
- `executor.js` now delegates to `getPoolDetail()` from `screening.js` instead of hitting raw Meteora API directly
- This ensures pool data goes through the same relay path (Agent Meridian) as screening, avoiding data mismatches

---

## SOL-Crash Circuit Breaker (June 2026)

**Why**: Single-sided SOL positions are SOL-denominated, so a SOL/USD crash trips per-position USD stop-losses across the entire book at once — token selection is irrelevant. Post-mortem of the Jun 25 drawdown: ~75% of the loss was SOL beta, not bad picks. This breaker hedges the whole normal book to USDC during a SOL dump.

- **Module**: `sol-crash-guard.js` (self-contained; dependency-injected close/swap/positions/notify fns — no imports from `executor.js`/`dlmm.js`/`wallet.js`). State persists to `sol-crash-state.json` (gitignored).
- **Trigger** (evaluated every management cycle — fires right after a normal stop-loss and as a catch-all): SOL is "dumping hard" when **≤ −3% in 1h OR ≤ −5% off its trailing 6h high**. Needs ≥ ~1h of price history first.
- **Action on trip**: close ALL normal positions → swap freed SOL to USDC (keeping `keepGasReserveSol`) → pause normal deploys + normal screening. Degen positions are untouched (degen runs on its own existing breaker; `scope: "normal"`).
- **Cooldown / re-entry**: `cooldownHours` (default 6h), then re-enter ONLY if SOL has stabilized (no longer dumping; `reentryRequiresStable`). Re-entry swaps back ONLY the parked USDC amount (`breaker.usdcParked`) — never operator-held USDC in the same wallet. If still dumping after cooldown, stays parked and re-checks each cycle.
- **Startup**: best-effort CoinGecko backfill of ~24h hourly SOL/USD (`backfillSolHistory()`) so the breaker is armed on boot rather than waiting hours to fill organically.

**Config (`config.solCrashGuard`, overridable via `user-config.json` under `solCrashGuard`)**:

| Key | Default |
|-----|---------|
| `enabled` | true |
| `drop1hPct` | 3 |
| `drawdown6hPct` | 5 |
| `cooldownHours` | 6 |
| `reentryRequiresStable` | true |
| `scope` | "normal" |
| `keepGasReserveSol` | 0.2 (falls back to `gasReserve`) |
| `backfillOnStart` | true |

**Integration points**:
- `index.js` `runManagementCycle()` — calls `solCrashGuard.tick({ solPrice, deps })` (samples price, then trips or re-enters); `backfillSolHistory()` runs once at boot.
- `tools/executor.js` `runSafetyChecks()` — gates `deploy_position`: blocks NORMAL deploys with `{ pass: false, reason }` while `solGuardCoolingDown()` is true (degen unaffected).
- `index.js` screening gates (`runScreeningCycle` and `runDeterministicScreen`) — pause normal screening alongside the existing `lossBreaker.triggered` check.

---

## Spectate Mode (June 2026)

A global watch-only mode. Cron cycles keep running and monitoring continues, but the agent takes **no** fund/position action — instead it emits "WOULD …" Telegram alerts so the operator acts manually.

**What it suppresses (when `config.spectateMode` is true):**
- **ALL write tools** via the `executeTool` chokepoint — `deploy_position`, `close_position`, `claim_fees`, `swap_token` return `{ blocked: true, reason: "Spectate mode — …" }` without executing (no SL/TP/close, no deploys, no claims/swaps). This is the hard enforcement layer; everything below is decision-site short-circuiting for cleaner behavior/alerts.
- **Screening + deploys** — both screening gates (`runScreeningCycle`, `runDeterministicScreen`) pause, same as the loss/SOL-crash breakers.
- **SOL-crash breaker stands down** — `solCrashGuard.tick()` runs with `observeOnly: true` (records price, reports `wouldTrip`, takes no action); a throttled `⚠️ [SPECTATE] WOULD trigger SOL-crash breaker` alert fires instead.
- **MANAGER LLM step** is skipped (monitoring only).
- **Deterministic close/claim loop** in `runManagementCycle` is skipped entirely (logs once: `Deterministic close/claim loop skipped (spectate mode).`) — avoids per-cycle "failed (Spectate mode…)" noise from the chokepoint.

**What continues:** position fetch, PnL, OOR detection, pool-memory snapshots, and `👁 [SPECTATE] WOULD close …` alerts from the 30s PnL poll exit/close-rule sites.

**Differs from `/pause`:** `/pause` stops the cron cycles entirely; spectate keeps cycles running (monitoring + alerts) and only suppresses actions.

**Toggle:** `/spectate on|off` Telegram command (bare `/spectate` reports current state + open-position count). Persists via `setSpectateMode(on)` in `config.js`.

**Config key:** `spectateMode` (top-level in `user-config.json`, default `false`).

**Integration points:**
- `config.js` — `spectateMode` flag + `setSpectateMode(on, configPath?)` (mutates live config, persists to `user-config.json`).
- `tools/executor.js` — `spectateWouldBlock(name)` predicate + the chokepoint in `executeTool` (blocks `WRITE_TOOLS` while spectating).
- `index.js` — guards in `runManagementCycle` (SOL-crash observe-only tick, MANAGER LLM skip, deterministic loop skip), the 30s PnL poll (WOULD-close alerts), the screening gates, and the `/spectate` command handler.

---

## Known Issues / Tech Debt

- `lessons.js evolveThresholds()` evolves `maxVolatility` + `minFeeTvlRatio` (wrong key names — should be `minFeeActiveTvlRatio`; `maxVolatility` doesn't exist in config at all). The evolution is a no-op for those keys.
- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
- **MiniMax-M2.7 intermittent failures**: The model occasionally fails to make tool calls (returns text-only response) or rejects `system` role messages. This is a model-level issue, not a code bug. Manifests as "I couldn't complete that reliably because no tool call was made" in screening/management cycles. Frequency: ~30 occurrences on May 11, ~6 on May 12. No code fix needed — retries on next cron cycle.
