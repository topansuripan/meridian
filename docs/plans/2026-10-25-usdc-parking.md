# USDC Parking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Idle funds sit in USDC. The bot parks SOL above the reserve after each close and swaps USDC back to SOL only to fund a deploy.

**Architecture:** Move `parkExcessSolToUsdc` / `ensureSolForDeploy` out of `tools/executor.js` into a root module `usdc-parking.js` with injected I/O. This follows the `wallet-reconcile.js` pattern. Fix the `solPrice` scope bug and add a rent buffer to funding. `executor.js` keeps thin config-gated wrappers. Then enable both flags on the VPS and park the currently idle SOL once.

**Tech Stack:** Node 20 ESM, `node:test`. Design: `docs/plans/2026-10-25-usdc-parking-design.md`.

**Conventions:**
- Run tests with `node --test test/<file>.js`. `npm test` is broken on Windows.
- Test files match `.gitignore` `test-*.js`, so add them with `git add -f`.
- Never `git commit -a`.
- Push only to `origin`. Never push to `yunus` or `upstream`.

---

### Task 1: `usdc-parking.js` with tests

**Files:**
- Create: `usdc-parking.js`
- Test: `test/test-usdc-parking.js`

**Step 1: Write the failing tests.** Use fake `getWalletBalances` and `swapToken` and `sleep = async () => {}`. Cover:

`parkExcessSol`:
- `sol 2.0, price 100, reserve 0.08`: swaps `1.92` SOL to the USDC mint. Returns `success: true`, `amount: 1.92`, `reserveSol: 0.08`, `reserveUsd: 8`. This is the regression test for the `solPrice` ReferenceError.
- The amount is floored to 4 dp, so the reserve is never dipped into. `sol 1.23456789` with reserve `0.08` gives `1.1545`.
- An excess under `$1` is skipped after all attempts, with no swap.
- No excess at all is skipped.
- A swap error comes back as `success: false`.

`fundSolForDeploy`:
- When SOL ≥ amount + reserve + `DEPLOY_RENT_SOL`: `success: true, skipped: true`, no swap.
- When SOL is short and USDC is enough: swaps `(target − sol) × price × 1.03` USDC, rounded to 2 dp, to `"SOL"`. Returns `success: true` with the `tx`.
- When USDC can't cover the target but SOL ≥ amount + reserve: skipped. This is the old floor and must not block.
- When USDC can't cover and SOL < amount + reserve: `success: false`, no swap.
- A swap that lands while SOL is still below amount + reserve gives `success: false` with an error.
- Without a SOL price: `success: false`.

**Step 2:** Run `node --test test/test-usdc-parking.js`. Expected: FAIL (module not found).

**Step 3: Implement `usdc-parking.js`:**
- Exports `DEPLOY_RENT_SOL = 0.05`, `parkExcessSol(deps)` and `fundSolForDeploy(amountSol, deps)`.
- `deps = { getWalletBalances, swapToken, reserveFor, usdcMint, sleep? }`, plus `minUsd`, `attempts` and `delayMs` for park and `settleMs` for fund.
- Keep the existing return shapes: `amount`, `reserveSol`, `reserveUsd` and the swap result spread for park; `tx`, `amountUsdc`, `reserveSol`, `minRequired` and `finalSol` for fund.

**Step 4:** Run the tests. Expected: PASS.

**Step 5: Commit**
```bash
git add usdc-parking.js && git add -f test/test-usdc-parking.js
git commit -m "feat(treasury): testable USDC parking module; fix solPrice crash and add rent buffer"
```

### Task 2: Wire `executor.js` to the module

**Files:** Modify `tools/executor.js`:
- the imports;
- `parkExcessSolToUsdc` / `ensureSolForDeploy` at lines 412–521;
- the close call site at ~1174.

1. Import `parkExcessSol` and `fundSolForDeploy` from `../usdc-parking.js`.
2. Replace the two function bodies with config-gated wrappers. Each one passes `{ getWalletBalances: () => getWalletBalances({}), swapToken, reserveFor: getTargetSolReserve, usdcMint: config.tokens.USDC }`.
3. Wrap `await parkExcessSolToUsdc()` in the close path in try/catch so it can't turn a landed close into an error. On failure, log `executor_warn` with "Auto-park after close failed".
4. Run `node --check tools/executor.js`, then `node --test test/test-usdc-parking.js test/test-smart-wallet-guard.js test/test-sol-crash-guard.js test/test-screening-reports.js`. Expected: all pass.
5. Update CLAUDE.md: add a `usdc-parking.js` row to the file table and a short treasury note.
6. Commit: `refactor(executor): use usdc-parking module for post-close park and deploy funding`.

### Task 3: Ship

1. Push and fast-forward the VPS:
   ```bash
   git push origin feature/degen-mode
   ssh vps 'cd /root/meridian && git fetch -q origin && git merge --ff-only origin/feature/degen-mode'
   ```
2. Set `autoParkUsdcAfterClose: true` and `autoFundSolFromUsdc: true` in the VPS `user-config.json`. Back the file up first.
3. Run `pm2 restart meridian --update-env` and check the logs for a clean boot.
4. Run the one-time park in a quiet window, between screening cycles with no deploy in flight. Use a node one-off that imports `envcrypt.js`, `tools/wallet.js` and `usdc-parking.js`, with the reserve computed as `max(gasReserve, solUsdReserve / price)`.
5. Verify on chain: wallet SOL ≈ reserve and USDC ≈ the parked value.
