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
| minVolatility / maxVolatility | screening | null / null |
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
| pendingSwapMinUsd | management | 0.10 |
| autoReconcileWallet | management | true |
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

### Pool Detail 404 Fallback (July 2026)
- **Why**: the relay's `/discovery/pools/{addr}` only serves pools currently in its discovery set, so it 404s for a valid pool that has rotated out (or is inconsistently cached — observed: a pool returned detail at 16:49, 404'd 90s later). `getPoolDetail` had no fallback, so a single 404 hard-blocked `deploy_position` via `validateDeployPoolThresholds` and set a 2h cooldown on both pool and token. Recurring: ~2–4×/day.
- **Fix**: `fetchPoolDiscoveryDetail` (screening.js) keeps the relay as primary (data consistency) but on a 404 / empty body falls back to the direct Meteora universal endpoint (`pool-discovery-api.datapi.meteora.ag/pools?filter_by=pool_address=…`), which serves any pool by address. Non-404 relay errors (5xx/etc.) still propagate — those are genuine failures, not a missing pool.
- Orchestration lives in `pool-detail-resolver.js` (`resolvePoolDetail({ primary, fallback })`, pure/injectable, unit-tested in `test-pool-detail-resolver.js`). The direct endpoint returns the same field shape (`tvl`, `fee_active_tvl_ratio`, `dlmm_params.bin_step`, `volatility`, `token_x`), and the volatility check reads from the 30m re-fetch (also routed through the fallback), so thresholds verify on real data.

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

## Swap Verification & Pending-Swap Retry Queue (July 2026)

**Why**: After closing a position, the base token sometimes stayed unswapped in the wallet and bled value. Three holes: (1) `swapToken` trusted Jupiter's execute response without confirming the tx landed on-chain, (2) nothing verified the wallet was actually clear of the token after a "successful" swap (partial fills / late-arriving tokens), (3) a failed swap-back was only logged once — never retried.

**Three layers of defense:**

1. **On-chain confirmation** (`tools/wallet.js`): `swapToken` now polls `getSignatureStatuses` (up to 15 × 3s, `searchTransactionHistory: true`) after Jupiter's execute and returns `success: false` unless the tx reaches confirmed/finalized with no error. A missing signature is also a failure.
2. **Post-swap wallet verification** (`tools/executor.js`): `autoSwapToSol` retries failed swaps within its attempt loop (instead of returning on first failure), and after a confirmed swap calls `verifyWalletClearOfToken()` — if the token balance is still above dust (`pendingSwapMinUsd`), it loops and swaps the remainder. Only returns `success: true` when the wallet is verifiably clear. The `claim_fees` auto-swap path routes through `autoSwapToSol` too.
3. **Persistent retry queue** (`pending-swaps.js`, state in gitignored `pending-swaps.json`): any swap-back that still fails after all attempts is queued via `addPendingSwap()`. `processPendingSwaps()` (executor.js) runs at the start of every management cycle — before the early returns, so it fires even with zero open positions — and retries each queued mint: wallet clear or dust → entry removed; swap succeeds + verified clear → removed + Telegram notify; still failing → attempt recorded, retried next cycle forever. Skipped in spectate mode and DRY_RUN. SOL/USDC can never be queued.

**Config**: `pendingSwapMinUsd` (management, default 0.10) — leftover token value below this is treated as dust and dropped from the queue.

**Tests**: `test-pending-swaps.js` (node:test, gitignored per convention) covers the registry: queue/dedupe, attempt history, SOL/USDC refusal, removal, corrupt-file recovery.

---

## Close-Verification Fix + Wallet Reconcile Sweep (July 2026)

**Why**: A stop-loss close of traindog (`2kcdBw85…`) confirmed its claim + remove-liquidity/close txs on-chain, but the relay lagged so `close_position`'s 4-attempt/~14s position-record recheck (`dlmm.js`) still saw the position and returned `{ success: false, error: "…still appears open after verification window" }`. `executor.js` gated the *entire* post-close pipeline — auto-swap-to-SOL, the retry-queue, and Telegram notifications — behind `if (success)`, so the base token the close had already delivered to the wallet was never swapped, never queued, and never reported. The position closed moments later (`auto-closed — missing from on-chain data`), leaving the token orphaned until the operator swapped it manually. The swap engine itself was fine — a position-record lag was suppressing the sweep.

**Module**: `wallet-reconcile.js` (pure/dependency-injected; no heavy imports so it unit-tests without a wallet).

**Two layers:**

1. **Root fix — decouple the sweep from position-record verification.** `close_position`'s verification-timeout return now carries `verification_timeout: true` + `base_mint` (the close txs are confirmed; only the recheck lagged). `shouldRunPostCloseSweep(result)` returns true for a real success OR for a `verification_timeout` with landed `close_txs`/`txs` + `base_mint`. `executor.js` runs the post-close pipeline when `success || runCloseSweep`, so the base token is swept back to SOL (and queued on failure) even on the lag. `index.js`'s deterministic close loop also treats `verification_timeout` as a successful close so it isn't reported as "failed".
2. **Safety-net sweep.** `reconcileWalletToSol()` swaps any stray non-SOL/USDC token above `pendingSwapMinUsd` back to SOL — backstop for every orphan path (verification lag, relay-zap fallback, late-arriving tokens, process restarts). Open-position `base_mint`s are protected from sweeping; sub-dust and no-liquidity (non-finite USD) tokens are left alone. Exposed as `reconcileWallet()` in `executor.js` (skips spectate/DRY_RUN, gated by `config.management.autoReconcileWallet`), called each management cycle from `index.js` right after `processPendingSwaps()`.

**Config**: `autoReconcileWallet` (management, default true) — per-cycle safety-net sweep of stray tokens → SOL.

**Tests**: `test-wallet-reconcile.js` (node:test, gitignored per convention) — `shouldRunPostCloseSweep` truth table (success / blocked / genuine failure / verification-timeout with & without base_mint & txs) and `reconcileWalletToSol` (sweeps strays, skips SOL/USDC/dust, protects open positions, queues on swap failure).

---

## Loss Quarantine + Min-Token-Age Deploy Gate (July 2026)

**Why**: Post-mortem of the record 2-day drawdown (Jul 11–12: −$21, all of it from 3 stop-loss closes). Two holes: (1) the `risk.lossQuarantine*` config keys existed in config.js / `update_config` / the `/status` line but were read by **nothing** — after a stop-loss the agent could immediately revenge-redeploy into the same token (observed: HOME-SOL deployed **5x in ~4h** on Jul 12, final leg gapped −17.42% in one 30s poll window, −$11). (2) The deploy gate never rechecked token age — HOME and Bison were both <24h-old tokens that rugged; screening's `minTokenAgeHours` filter can be bypassed by stale/side-channel candidates.

- **Loss quarantine (now enforced)**: `evaluateLossQuarantine(deploys, config.risk)` in `pool-memory.js` (pure, unit-tested in `test-pool-memory-loss-cooldown.js`), called from `recordPoolDeploy()`. A deploy is a *qualifying loss* if its close reason matches stop-loss (reason match catches fee-offset PnL above the pct threshold) OR `pnl_pct <= lossQuarantineMinPnlPct`; range events (OOR / "pumped far above range") are exempt — the OOR cooldown handles those. When the last `lossQuarantineTriggerCount` deploys all qualify, both the pool and the base mint get a `lossQuarantineHours` cooldown (screening already filters via `isPoolOnCooldown`/`isBaseMintOnCooldown`). Defaults: 2x / 24h / −8%. VPS runs 1x / 24h / −5%.
- **Min-token-age deploy gate**: `getTokenAgeGateReason(detail, config.screening)` in `screening.js` (pure, unit-tested in `test-token-age-gate.js`), enforced in `runSafetyChecks()` for NORMAL deploys (degen exempt, same as the pump guard). Missing `created_at` never blocks; accepts ms/seconds epoch or ISO strings. VPS: `minTokenAgeHours` raised 6 → 48.
- **Loss breaker retuned**: `maxDailyLossUsd` 80 → 10 on the VPS (80 allowed a −67% day on a ~$120 book before pausing; Jul 12 bled −$15.8 without tripping). The breaker itself was verified live (`getLossCircuitBreakerStatus` in lessons.js, gates both screening paths).

---

## Fast-Drop Recovery-Exit Guard (July 2026)

**Why**: The book is single-sided SOL and we want stability, not big dumping. The absolute
`stopLossPct` (-50%) is a *level*, not a *rate* — it does nothing when a position falls fast
while still above -50%. This guard adds a velocity signal, but avoids panic-selling at the
bottom: after a sharp drop it waits to exit into a bounce.

- **Module**: `fast-drop-guard.js` — pure/dependency-injected (mirrors `sol-crash-guard.js`).
  `evaluateFastDropGuard({ samples, watch, currentPnlPct, now, cfg })` → `{ watch, samples, action, reason }`.
  Value proxy is `factor = 1 + pnl_pct/100` (IL + price + fees).
- **State machine (per position, NORMAL only)**: track a rolling `fastDropWindowMinutes` (15m)
  buffer of value samples. Arm a "recovery watch" when value drops ≥ `fastDropTriggerPct` (15%)
  from the rolling high. While watching, keep trailing the low; exit (`FAST_DROP_EXIT`) on any of:
  PnL returns to breakeven (≥0%, checked first as the more meaningful label), value bounces
  ≥ `fastDropBouncePct` (10%) off the low, or PnL hits the `fastDropHardFloorPct` (-25%) hard floor.
- **Integration**: `state.js updatePnlAndCheckExits()` evaluates it each 30s poll (before the
  absolute stop-loss) and persists `fast_drop_samples` + `fast_drop_watch` in `state.json` so an
  active watch survives restarts (~15m sample re-warm after a restart). The returned
  `FAST_DROP_EXIT` flows through the existing 30s-poll close/alert path (spectate "WOULD close"
  + management trigger) unchanged — not routed through the `TRAILING_TP` confirmation branch.
  Skipped when `pnl_pct_suspicious`. Degen exempt (`buildDegenMgmtConfig()` never sets `fastDropGuardEnabled`).
- **Config (`config.management`)**: `fastDropGuardEnabled` (true), `fastDropWindowMinutes` (15),
  `fastDropTriggerPct` (15), `fastDropBouncePct` (10), `fastDropHardFloorPct` (-25). All via `update_config`.
- **Tests**: `test-fast-drop-guard.js` (node:test) — arm/no-arm, trailing low, bounce/breakeven/floor exits, window expiry, disabled, null-pnl skip.

---

## Known Issues / Tech Debt

- `lessons.js evolveThresholds()` evolves `maxVolatility` + `minFeeTvlRatio` (wrong key names — should be `minFeeActiveTvlRatio`; `maxVolatility` doesn't exist in config at all). The evolution is a no-op for those keys.
- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
- **MiniMax-M2.7 intermittent failures**: The model occasionally fails to make tool calls (returns text-only response) or rejects `system` role messages. This is a model-level issue, not a code bug. Manifests as "I couldn't complete that reliably because no tool call was made" in screening/management cycles. Frequency: ~30 occurrences on May 11, ~6 on May 12. No code fix needed — retries on next cron cycle.
