# USDC Parking Design

**Goal:** Idle funds sit in USDC, not SOL. They are swapped back to SOL only when the bot deploys.

## What already exists

Both halves are already in `tools/executor.js`. Each one is off on the VPS.

- `parkExcessSolToUsdc()` runs after a successful `close_position` and swaps SOL above the target reserve to USDC. It is gated by `management.autoParkUsdcAfterClose`.
- `ensureSolForDeploy(amountSol)` runs before `deploy_position` executes. It swaps (deficit × 1.03) USDC → SOL, waits 4 s, and checks the new balance. It blocks the deploy if funding fails. It is gated by `management.autoFundSolFromUsdc`.
- The target reserve is `max(gasReserve, solUsdReserve / solPrice)`, about $8 of SOL.
- Every deploy-side check already treats USDC as liquid buying power: the screening pre-check, `computeDeployAmount`, the degen pre-check and the deploy safety check. The reconcile sweep never touches SOL or USDC.

## The bug

`parkExcessSolToUsdc` declares `solPrice` inside its retry loop. The return statement reads `solPrice` outside that loop. Every successful park therefore throws a `ReferenceError` after the swap has already landed. The outer `executeTool` catch then reports `close_position` as failed to the LLM, and the swap notification and the `parked_to_usdc` flags are lost. It never fired on the VPS because the feature was off.

## Changes

1. Move the two helpers into `usdc-parking.js`, a root module with injected I/O (`getWalletBalances`, `swapToken`, `sleep`, `reserveFor`, `usdcMint`). This is the same pattern as `wallet-reconcile.js`. `executor.js` keeps thin wrappers that check the config flags and pass in the real dependencies.
2. Fix the `solPrice` scope.
3. Add tests in `test/test-usdc-parking.js`:
   - a park succeeds and returns the amount, the reserve and the reserve in USD;
   - the reserve stays as SOL;
   - an excess under $1 is skipped;
   - funding swaps only the shortfall × 1.03;
   - funding is skipped when SOL already covers the deploy and the reserve;
   - funding fails without swapping when USDC is short;
   - funding fails when a swap lands but SOL is still short.
4. Turn on `autoParkUsdcAfterClose` and `autoFundSolFromUsdc` in the VPS `user-config.json`.
5. Deploy and restart, then park the SOL that is already idle once, everything above the reserve.

## Rent buffer (added after reading the chain)

Each meridian deploy pays 0.042–0.044 SOL of position rent on top of the amount. The rent is refunded on close. Until now the wallet always held far more SOL than a deploy needed. Once funds are parked, a top-up to exactly amount + reserve would let the rent eat the gas reserve. At $200 SOL the $8 reserve is only 0.04 SOL, so that reserve would be gone entirely.

`fundSolForDeploy` therefore targets amount + reserve + `DEPLOY_RENT_SOL` (0.05 SOL). If USDC can't cover the buffer but SOL already covers amount + reserve, the deploy goes ahead as before rather than being blocked. The post-swap check uses that same floor, so slippage on the buffer never blocks a deploy.

A park that throws is caught at the `close_position` call site. A close that already landed is therefore never reported to the LLM as failed.

## Review fixes

A code review before shipping found these, and all of them are fixed:
- **The opportunity poller only checked SOL.** That would have silently stopped it once funds were parked. It now uses the liquid SOL equivalent plus the reserve.
- **There was no lock between a top-up and its deploy, or around each park.** One treasury mutex now covers both.
- **A string `amount_y` broke the funding math.** It is now coerced and validated.
- **Funding checked the balance only once after the swap.** It now polls.
- **DRY_RUN faked a park.** Parking is now skipped under DRY_RUN.
- **Funding couldn't top up partially.** It now swaps whatever USDC there is when that covers deploy + reserve.
- **The park notification showed raw USDC units.** It now shows normal units.
- **SOL-crash guard:** re-entry no longer swaps its USDC back when deploy funding is on. The trip-time SOL→USDC swap keeps the parking reserve, because `keepGasReserveSol` falls back to `gasReserve`, which is 0 on the VPS.

## Behaviour after

- A position closes. The token is swapped to SOL as today. Then SOL above about $8 is swapped to USDC.
- The bot deploys X SOL. If wallet SOL is below X + reserve, it swaps the shortfall from USDC and then deploys.
- Each park or top-up sends a swap message, so at most two per position.

## Risks

- Every position now costs two extra SOL↔USDC swaps. Fees on that pair are small.
- If a top-up fails, that deploy is blocked and retried next cycle. Funds are never stranded.
- The SOL-crash guard still swaps back only the USDC it parked itself. With parking on, its re-entry adds one extra round trip after a crash, which is harmless.
- SOL that arrives from other sources, such as claimed fees, stays as SOL until the next close parks it.
