# FloatSheets Copper: penny-stock perps

Copper lists perps on the **10 lowest-market-cap official Robinhood Stock Tokens** on their own oracle, vault and clearing house. Large caps stay on Goldlake and Jaguar; penny risk sits in Copper's vault only.

**Copper deploys the existing audited contracts.** `FloatOracle`, `FloatInstantVault` and `FloatClearingHouse` are byte-for-byte the code Jaguar runs; only the market parameters differ. Copper uses Jaguar's instant vault, so team liquidity counts the moment it's deposited (no 24-hour LP queue).

Snapshot: 2026-10-22. Market caps come from stockanalysis.com and are recorded in `backend/scripts/penny-market-caps.json`.

## The 10 markets

| # | Ticker | Company | Market cap | Price source | Launch | Cap |
|---|---|---|---|---|---|---|
| 1 | WYFI | WhiteFiber | $411M | Robinhood | 5× | $500 |
| 2 | NNE | NANO Nuclear Energy | $684M | Robinhood | 5× | $1,000 |
| 3 | RCAT | Red Cat Holdings | $686M | Robinhood | 5× | $1,000 |
| 4 | TE | T1 Energy | $701M | Robinhood | 5× | $500 |
| 5 | XNDU | Xanadu Quantum | $833M | Robinhood | 5× | $1,000 |
| 6 | POET | POET Technologies | $929M | Robinhood | 5× | $1,000 |
| 7 | FLNC | Fluence Energy | $1.06B | Robinhood | 5× | $1,000 |
| 8 | QUBT | Quantum Computing | $1.52B | Robinhood | 5× | $1,000 |
| 9 | RUN | Sunrun | $1.82B | Robinhood | 5× | $500 |
| 10 | DJT | Trump Media & Technology | $1.85B | Robinhood | 5× | $1,000 |

- **Launch profile:** 5× with 5% maintenance margin on every market. A position is liquidated after roughly a 15% adverse move.
- **Step-up profile** (after 14 days without bad debt): 10× / 6% for the two-source markets; single-source markets stay at 5×.
- **Closure profile** (before each weekend or holiday): 3× / 25% maintenance.
- **Cap** is the maximum position notional.
- **Excluded:** BNC ($213M) would rank first, but its on-chain "Robinhood Token" is an impostor, not a Robinhood beacon proxy. Every listing is checked against Robinhood's own quote feed and the beacon.

## How Copper prices these markets

Their Uniswap pools are empty or a few thousand USDG deep, so pools are never price sources. `ReferencePriceMonitor` (`backend/src/prices/reference.ts`) polls two off-chain sources that trading on Robinhood Chain can't move:

1. **Robinhood:** `rhj/prices` token bid/ask, matched by the official contract address. A quote counts only once it has been seen changing, and is stale after 10 unchanged minutes.
2. **Pyth (optional cross-check):** the equity feed × the token's `uiMultiplier()`. Every market opens on Robinhood's quote alone (migration 019). Pyth joins when `PYTH_API_KEY` is set on a plan that covers US equities (a crypto-only plan returns 403 "Not entitled"); a disagreement between live sources then blocks opens.

The published mark is the median of fresh sources, with spot equal to the mark, so the stock oracle's 50 bps spot/TWAP band never freezes it. Moves larger than the 20% jump guard are walked in 19% steps by the publisher; each step is a clean mark, so liquidations keep running.

**New positions are refused when:** sources disagree by more than 150 bps; fewer than the market's minimum sources are live; a multiplier change is pending; the mark is more than 300 bps from its 15-minute average; the on-chain mark lags the live price; or the market hasn't collected 20 live marks yet (warm-up). Weekend and holiday rules (bands, wallet limits, 3× cap from 6h before a closure) also apply.

**Frozen** (a Robinhood halt, `oraclePaused()`, or no live source): the last good mark is held, liquidations pause, closes stay open at a 7% spread, and a close that would lose more than its margin waits for the reopen.

## What changed from the delivered Copper files

- **No contract changes:** the per-market `setOracleConfig` oracle change was dropped. Copper runs the stock oracle.
- **Instant vault:** `DeployCopper.s.sol` deploys `FloatInstantVault` (as Jaguar does), so no LP queue or epoch keeper is needed for Copper. The extra vault-epoch keeper was removed; Goldlake's queue is still settled by the existing keeper.
- **5× launch** instead of 15× / 10×.
- **More markets (Hyperliquid, Ostium routing) left out** of this release.
- Migration renumbered to `017_copper_penny_markets.sql`.

## Go-live runbook (owner)

**1. Deploy.** Owner = deployer EOA.

```bash
cd contracts
USDG_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 OWNER_EOA_ADDRESS=<owner> DEPLOYER_ADDRESS=<owner> \
ORACLE_SIGNER_ADDRESS=<oracle signer> QUOTE_SIGNER_ADDRESS=<quote signer> PROTOCOL_FEE_WALLET=<fee wallet> \
forge script script/DeployCopper.s.sol --rpc-url rhc --broadcast --account <keystore>
```

Record the addresses and block in `contracts/deployments/copper-4663.json`, following `jaguar-4663.json`.

**2. Configure the markets, paused.**

```bash
FLOAT_ORACLE_ADDRESS=<copper oracle> FLOAT_CLEARING_HOUSE_ADDRESS=<copper clearing house> \
forge script script/ConfigureCopperMarkets.s.sol --rpc-url rhc --broadcast --account <keystore>
```

**3. Backend (Render).** Set `COPPER_FLOAT_CLEARING_HOUSE_ADDRESS`, `COPPER_FLOAT_ORACLE_ADDRESS`, `COPPER_FLOAT_VAULT_ADDRESS`, `COPPER_DEPLOYMENT_BLOCK` and `PYTH_API_KEY`, then redeploy. Migration 017 runs on start. Check the logs for no `reference_market_restricted_unverified_token`.

**4. Fund.** Deposit team USDG into the Copper vault (it counts immediately): 25,000 minimum, 50,000 recommended (about $5k one-sided open interest per market). Add the team wallet to `COPPER_LP_ALLOWLIST` to deposit through the dashboard, or deposit to the vault contract directly. Keep the oracle/keeper wallet funded with RH ETH (0.05 recommended): reference marks republish on every 25 bps move.

**5. Watch the marks**, then go Active. `GET /v1/markets` with header `x-floatsheets-contract-version: copper` shows `sources_used`, `source_dispersion_bps` and `frozen_reason`. When marks are live and agreeing, rerun step 2 with `COPPER_MARKET_STATE=1`.

**Weekly (closure autopilot):** before each weekend or holiday close (by 14:00 ET), run `contracts/script/copper-profile.sh closure`; after the reopen, run `contracts/script/copper-profile.sh launch`. Addresses come from `contracts/deployments/copper-4663.json`. The backend watches Copper's on-chain leverage against the NYSE calendar, messages the Telegram account linked to the Copper owner wallet when a switch is due, and flags a missed switch on the status page (`GET /v1/copper/closure`).

**After 14 days with zero bad debt:** run `contracts/script/copper-profile.sh step-up`.

**Refreshing the list:** re-pull market caps into `penny-market-caps.json`, run `bun scripts/discover-penny-markets.ts --pools-cache pools.json`, and review the generated SQL. The 10 slots are full, so swapping a market needs `deregisterMarket` on an empty market first.

## Risks and limits

- **Gaps:** penny names gap 20–40% overnight. A gap past a position's margin becomes bad debt on the Copper vault; bad debt pauses new Copper opens only. Caps ($500–$1,000 per position, open interest ≤ 15% of the vault per market) bound the loss.
- **Frozen exits** cost 7%, and a close that would exceed its margin waits for the reopen.
- **The closure profile is a manual owner step.** If it's skipped, positions opened mid-week ride the weekend gap; the 3× cap only stops new ones.
- **Single source:** every market opens on Robinhood's quote alone until Pyth equities are added: a stale quote stops opens, but a wrong fresh quote would be signed.
- **Data terms:** `rhj/prices` is Robinhood's public token quote endpoint; its terms for commercial reuse are unverified. Pyth Hermes needs an API key.
- **Still open from the last audit:** single-EOA owner, signers inside the API process, no timelock. Copper inherits all three; team liquidity only until they're fixed.
- **US persons:** perps on single US stocks can't be offered to US persons. Geofence Copper.
