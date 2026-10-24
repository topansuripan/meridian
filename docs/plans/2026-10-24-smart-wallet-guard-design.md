# Smart-Wallet Presence Guard — Design

**Date:** 2026-10-24
**Branch:** feature/smart-wallet-guard (off origin/feature/degen-mode @ f57894d)
**Scope:** Normal deploys only (degen exempt)

## Problem

Smart wallets are only a *soft* signal today: `checkSmartWalletsOnPool` nudges the LLM's
confidence and lowers the opportunity poller's bar by `smartWalletScoreBonus`. Nothing can
stop a deploy for lack of smart money. We want a hard guard: **only open an LP when wallets
we trust are already LPing that token.** (On the VPS `smart-wallets.json` does not exist yet,
so the list is empty — the guard ships OFF.)

## Rule

A normal deploy passes only when at least `smartWalletMinCount` (default 1) tracked wallets
of `type: "lp"` hold an **open Meteora DLMM position in any pool of the candidate's base
token** — matched by base mint against both mints of each pool the wallet LPs. Not the exact
pool: a token usually has several pools (bin steps 80/100/125, SOL vs USDC) and meridian
picks one of them. `type: "holder"` wallets are ignored, as today.

## Flow

```
 Screening finds candidate pools
              │
              ▼
   ★ presence pre-filter ── fail ──► pool dropped (LLM never sees it)
              │ pass
              ▼
      LLM picks a pool
              │
              ▼
       deploy_position  ◄── also: opportunity poller, manual Telegram deploy
              │
              ▼
   runSafetyChecks (tools/executor.js)
    • mint/freeze authority, token age, pump guard, Saturday rule
    • ★ smart-wallet presence guard ── fail ──► ⛔ blocked
              │ pass
              ▼
          Open LP
```

## Lookup

`createPresenceChecker({ listWallets, fetchPositionPools, fetchPoolMints, notify, now })`
in `smart-wallets.js` returns `{ check({ baseMint, minCount }) }` — dependency-injected like
`sol-crash-guard.js`. `evaluateSmartWalletGuard({ baseMint, isDegen })` wraps the default
instance with the config switch and degen exemption; every call site uses the wrapper.

1. For each `lp` wallet: open DLMM positions via `getProgramAccounts(LBUZK…, memcmp owner @40)`
   → lbPair address = `data[8..40]`. **Per-wallet cache 5 min.** Wallets are fetched
   sequentially with a small delay (public `RPC_URL` rate-limits `getProgramAccounts`).
   The Meteora PnL enrichment in `getWalletPositions` is NOT used — the guard only needs pools.
2. lbPair → mints via one batched `getMultipleAccountsInfo`; `tokenXMint = data[88..120]`,
   `tokenYMint = data[120..152]` (verified on DMXK4u68… and Gc5hVCBy… 2026-10-24). **Cached
   forever** (a pool's mints never change).
3. Count wallets whose mint set contains `baseMint`.

If a wallet's fresh lookup fails but a cached result ≤30 min old exists, use it (rides out
transient 429s).

## Outcomes

| Situation | Result |
|---|---|
| guard disabled (default) | allow — check skipped |
| degen deploy | allow — exempt |
| count ≥ minCount | allow (even if some lookups failed — presence is proven) |
| count < minCount, all lookups OK | block, logged + decision-log entry |
| count < minCount, some lookup failed | block as *unverified* + Telegram alert |
| list has no `lp` wallets | block + Telegram alert |

Alerts are rate-limited to one per failure kind per 6 h, so a dead RPC can't silently idle the
bot (cf. the 2026-09-15 Helius incident) and can't spam either.

## Call sites

- `tools/executor.js` `runSafetyChecks` → hard gate beside the Saturday rule (covers every path).
- `index.js` screening candidate filter (~L908) → drop failing candidates with reason
  `smart wallets 0/N`; the LLM prompt's `smart_wallets:` line uses the token-level result.
- `index.js` opportunity poller → when the guard is on, a candidate only triggers screening
  if it has presence (reuses the cache).

## Config (user-config.json → config.js)

- `smartWalletGuardEnabled` — default `false`
- `smartWalletMinCount` — default `1`

List management needs no new code: chat "add smart wallet <addr> as X" → existing
`add_smart_wallet` / `list_smart_wallets` / `remove_smart_wallet` tools.

## Testing

`test/test-smart-wallet-guard.js` (plain node + assert, like the other `test/` scripts) with
fake fetchers: pass at threshold; block at 0; partial failure but threshold met → pass;
failure and not met → unverified + alert; empty list → block + alert; stale-cache fallback;
quote mint (SOL/USDC) alone never counts as presence; disabled → skip. Then a read-only
`node cli.js smart-wallet-check --mint <mint>` smoke run on the VPS before enabling.

## As built (changes from code review)

- **Checker:** pool-mint misses are re-resolved after 10 min (never cached forever), and the mint cache is cleared at 10k entries. A wallet whose lookup failed is backed off for 60 s, and the stale cache is used meanwhile. Concurrent checks share one in-flight lookup per wallet. Wallets are deduped by address. A missing base mint raises a rate-limited alert.
- **Wallet list:** a corrupt or wrongly shaped `smart-wallets.json` yields kind `list-error` plus an alert, never a silent idle. `add/removeSmartWallet` refuse to overwrite an unparseable file.
- **RPC:** the position lookup filters on the PositionV2 discriminator (`LgkNAEYaVX3`, from the SDK's `positionV2Filter`) as well as the owner, so foreign accounts can't spoof presence. Pool reads require the LbPair discriminator. The Connection runs with `disableRetryOnRateLimit` and a 15 s abort signal.
- **Executor:** the gate runs after the free amount checks, uses only the resolved pool mint (never the LLM's `base_mint`), and honours `degen: true` only while degen mode is enabled; the exemption follows the runtime degen mode (`/degen on|off` now keeps `config.degen.enabled` in sync). Only a verified `none` sets the 2 h pool/token cooldown; infra failures don't.
- **Screening:** presence is checked first, so dropped candidates cost no Jupiter calls. With the guard on, the prompt's smart-wallet line is neutral (`guard passed … not a differentiator`), because every surviving candidate has presence and the old "CONFIDENCE BOOST" line would loosen the narrative rules. The Darwin signal `smart_wallets_present` is recorded as `null`. Guard drops are listed after the GMGN funnel in the no-candidates report.
- **Opportunity poller:** with the guard on, a pool must still reach `s >= minScore`; presence never lowers the bar (the borderline bonus applies only with the guard off).
- **Known limit:** a position whose liquidity was fully withdrawn but whose account was never closed still counts as presence. Checking `liquidity_shares` would make each response about 35× larger.

## Rollout

Commit → push `origin feature/smart-wallet-guard` → merge into `feature/degen-mode` → VPS
`git merge --ff-only` → `pm2 restart meridian` (0 open positions now). Guard stays off until
wallets are added and `smartWalletGuardEnabled: true` is set.
