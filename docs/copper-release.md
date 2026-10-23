# FloatSheets Copper: penny-stock perps + routed "More markets"

Copper is a new FloatSheets release (own oracle, vault and clearing house) that lists perps on the **10 lowest-market-cap official Robinhood Stock Tokens**, with high leverage and small position caps. The dashboard also gets a **More markets** tab that routes trades to Hyperliquid HIP-3 equity perps and Ostium stock pairs and earns FloatSheets a builder fee on each fill.

Snapshot: 2026-10-22. Market caps come from stockanalysis.com and are recorded in `backend/scripts/penny-market-caps.json`.

## Do first: make the live vault usable (Goldlake, today)

Checked on chain on 2026-10-22 13:28 ET: Goldlake's vault `0x24B530f2ef4c76D10003e861182208ceA4120C45` held **101 USDG, all as a pending deposit**. `totalAssets()` was 0, so every open failed the open-interest cap (15% of vault per market, 10% one-sided). LP deposits wait for the daily queue round, which is intended (audit fix M-1). But **nothing ever closed the round**: `settleQueue()` and `startNextQueueEpoch()` are permissionless and nobody called them.

- **Fix in this build:** `backend/src/keeper/vault-epochs.ts`. The keeper wallet settles a due round and opens the next one, checking every 5 minutes, on Goldlake and Copper.
- **Tonight, if the new backend isn't live yet:** after **23:38 ET** (round 0 started 03:38 ET), any wallet calls `settleQueue()` then `startNextQueueEpoch()` on the vault. Then each depositor calls `claimDeposit(0)` for their shares. The liquidity is usable from `settleQueue()`.
- **Deposit seed USDG before 23:38 ET** to land in tonight's round.

**Recommended funding**

| What | Minimum | Recommended | Why |
|---|---|---|---|
| Goldlake vault | 10,000 USDG | **50,000 USDG** | ~$5k one-sided OI per market (10% cap) |
| Copper vault (after deploy) | 25,000 USDG | **50,000 USDG** | ~$5k one-sided per penny market; a 40% gap on that is ~$1.7k of bad debt per market |
| Oracle/keeper wallet `0xC815512FCf2acb22F23f1d918BD0Ea674D9ECaA4` | 0.02 ETH | **0.05 ETH** | Held 0.00028 ETH (≈175 publishes at ~1.6e-6 ETH each). Copper republishes on every 25 bps move |
| Owner `0x4a4c4e9Ad9afc8c5603ef5EA91cEf98CCdFE91f3` | 0.005 ETH | **0.01 ETH** | Copper deploy + configure + weekly closure profile |

**No Uniswap pool top-up is needed.** Goldlake's pools are deep (NVDA $694k, CRCL $1.5M, AMC $271k), and Copper doesn't price from pools.

## The 10 markets

| # | Ticker | Company | Market cap | Price sources | Launch leverage | Cap |
|---|---|---|---|---|---|---|
| 1 | WYFI | WhiteFiber | $411M | Robinhood | 10× | $500 |
| 2 | NNE | NANO Nuclear Energy | $684M | Robinhood + Pyth | 15× | $1,000 |
| 3 | RCAT | Red Cat Holdings | $686M | Robinhood + Pyth | 15× | $1,000 |
| 4 | TE | T1 Energy | $701M | Robinhood | 10× | $500 |
| 5 | XNDU | Xanadu Quantum | $833M | Robinhood + Pyth | 15× | $1,000 |
| 6 | POET | POET Technologies | $929M | Robinhood + Pyth | 15× | $1,000 |
| 7 | FLNC | Fluence Energy | $1.06B | Robinhood + Pyth | 15× | $1,000 |
| 8 | QUBT | Quantum Computing | $1.52B | Robinhood + Pyth (+ pool) | 15× | $1,000 |
| 9 | RUN | Sunrun | $1.82B | Robinhood | 10× | $500 |
| 10 | DJT | Trump Media & Technology | $1.85B | Robinhood + Pyth + pool | 15× | $1,000 |

- **Cap** is the maximum position notional. The **max** profile (after 14 clean days) is 18× / $1,000 for tier 1 and 15× / $500 for tier 2. 18× is the contract ceiling, because `maxLeverageE18` is a `uint64`.
- **Excluded:** BNC ($213M) would rank #1. But its on-chain "Robinhood Token" is an impostor, not a Robinhood beacon proxy, and Robinhood's price list has no BNC. 84 impostor "• Robinhood Token" contracts exist on chain, so every listing is checked against the beacon.

## How Copper prices these markets

Their Uniswap pools are empty or hold a few thousand USDG. Only DJT (~$31k) and QUBT (~$12k) have real depth, and a pool that $1k can move is not an oracle. `ReferencePriceMonitor` (`backend/src/prices/reference.ts`) uses two off-chain sources, neither of which trading on Robinhood Chain can move. It polls every 15 s:

1. **Robinhood:** `rhj/prices` `tokenBid` / `tokenAsk`, matched by the official contract address. A quote whose bid/ask hasn't changed for 10 minutes counts as stale.
2. **Pyth:** the equity feed × the token's on-chain `uiMultiplier()`. It is dropped for 24h after a multiplier change.

**Pools are not price sources.** Their spot price can be pushed for the cost of a few thousand USDG.

**The mark is the live price, not a lagging TWAP.**
- The published mark is the median of fresh sources. If the two sources disagree by more than 150 bps, Robinhood's quote alone is used.
- The publisher republishes whenever the mark moves 25 bps from the on-chain price, and on every quote request. Large gaps are walked at once, in the largest steps the 40% jump guard allows.
- Entries, exits and liquidations therefore happen near the real price.
- A 15-minute average of the mark is kept only as a sanity band: no new positions while the mark is more than 300 bps from it.

**New positions are refused when:**
- sources disagree;
- fewer than `min_sources_for_open` sources are live (tier 1: 2, tier 2: 1);
- a multiplier change is pending within 24h;
- the mark is outside the sanity band;
- the on-chain mark lags the live price by more than 50 bps;
- the quoted spread is more than half of the margin headroom above maintenance, so a new position can't be liquidatable on open.

**More safeguards:**
- **Warm-up:** opens need at least 20 live marks in the averaging window, so the first tick after a halt or a weekend can't open at a stale average.
- **Short quotes:** reference-market quotes expire within 15 s.
- **Fast republish:** exposed reference marks republish on every reference poll (5 s) when they move more than 25 bps, which invalidates older quotes through `oracleSequence`.
- **Restart safety:** after a restart, a Robinhood quote counts only once it has been seen changing, using `reference_quotes` history.
- **Hold length:** the hold lasts 120h, enough to cover a four-day holiday weekend.
- **Weekend and holiday leverage:**
  - From 6h before a weekend or holiday closure, and during it, new penny risk is capped at 3× on the whole position.
  - The owner runs `COPPER_LEVERAGE_PROFILE=closure` before each closure (3× / 25% maintenance), so positions above 3× add margin or are liquidated by the keeper at the live price before the market freezes. Run `launch` again after the reopen.
  - This closes the "hedged long+short into a Monday gap" play.
- **Frozen closes:** a close while frozen that would lose more than the position's margin waits, instead of recording bad debt, which would pause all Copper opens.
- **Fake tokens:** a token that is neither a Robinhood beacon proxy nor in Robinhood's own price feed makes the market `restricted` (close-only), never `disabled`.

**Frozen.** Triggers: a halt reported by Robinhood, `oraclePaused()`, or no live source (the last good mark is then held for up to 72h).
- The publisher signs the mark with the on-chain breaker set.
- Liquidations and LP queue settlement pause.
- Closes stay open, quoted at a 7% spread.
- Exits are priced off the worse of the on-chain mark and the live price for the trader. If the on-chain mark is still catching up to a move larger than the 7.5% execution bound, the close asks the trader to retry a few seconds later instead of filling at a stale price.

**Quote samples:** quotes are the Robinhood half spread (or the market floor) plus a small size impact (`notional / 250k / 2`). The results land in `pool_snapshots` and `quote_samples`, so the publisher, risk screen, quote service and dashboard are shared with Goldlake.

## What changed

| Area | Change |
|---|---|
| `FloatOracle.sol` | Per-market `setOracleConfig(marketId, deviationBps, jumpBps)` (bounds 10–1,500 / 500–5,000; zero = old defaults 50 / 2,000), plus `effectiveOracleConfig` view. Copper uses 300 / 4,000: the breaker band is the frozen signal, and a gap of up to 40% is published in one step. Existing releases are untouched (new bytecode only for new deployments) |
| Clearing house / vault | **Unchanged.** Copper deploys the same clearing-house and vault code as Goldlake. `MAX_MARKETS = 10` fits the 10 names exactly. Breaker-time liquidations still revert on-chain; Copper avoids breaker time instead by publishing the live mark |
| `ConfigureCopperMarkets.s.sol` | Sets the oracle config, registers or updates all 10 markets and enables oracle publication. `COPPER_MARKET_STATE` (3 = Paused, 1 = Active) and `COPPER_LEVERAGE_PROFILE` (`launch`, `max` or `closure` = 3× / 25% maintenance) |
| Migration `016` | `price_source`, `releases[]`, `listing_class`, per-market oracle thresholds, `token_address`, `pyth_feed_id`, `min_sources_for_open`, market cap. Snapshot `oracle_frozen` and `reference_average_usdg`. New `reference_quotes` audit table. The 10 rows. QUBT is shared with Goldlake: it is close-only there with no exposure, and its mark (spot = TWAP = mid) never trips Goldlake's 50 bps band |
| Backend | `copper` release everywhere (config, publisher, keeper, claims, alerts, routes). Opens and deposits are allowed on Goldlake and Copper. Publisher thresholds are read from each oracle on chain. Each reference market's token must be listed in Robinhood's own quote feed or be a Robinhood beacon proxy (checked hourly); a market that fails is set `restricted` (close-only, so open positions can still exit). Copper LP deposits stay closed until `COPPER_LP_DEPOSITS_ENABLED` or the allowlist (API/UI gate; the vault contract itself is permissionless). New `VaultEpochKeeper` settles and rolls the daily LP queue (`settleQueue` / `startNextQueueEpoch`) on Goldlake and Copper every 5 minutes when `KEEPER_ENABLED`. `/v1/venues` catalog and Ostium price proxy |
| Frontend | Large caps / Penny stocks / More markets switch on the Markets page; Copper in Settings; `src/lib/venues.ts` (Ostium `openTrade` with builder fee, Hyperliquid agent + builder-fee approval + IOC orders via `@nktkas/hyperliquid`); Arbitrum added to wagmi for Ostium only |
| Tools | `backend/scripts/discover-penny-markets.ts`: scans every USDG pool, keeps official tokens, ranks by market cap and writes JSON plus seed SQL. It reproduced the same 10 independently |
| Tests | Backend 109/109 (Postgres integration + live-chain test), frontend 23/23, contracts 94/94 including the Robinhood Chain fork suite. Backend and frontend typecheck clean, production build OK. A full backend boot against mainnet RPC served `/ready`, `/v1/protocol`, `/v1/status`, `/v1/markets` (Goldlake, live reads) and `/v1/venues/markets`; Copper routes answer "not deployed" until step 3 |

## Go-live runbook

**1. Deploy.** Same script as Goldlake, owner = your deployer EOA.

```bash
cd contracts
USDG_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 OWNER_EOA_ADDRESS=<owner> DEPLOYER_ADDRESS=<owner> \
ORACLE_SIGNER_ADDRESS=<oracle signer> QUOTE_SIGNER_ADDRESS=<quote signer> PROTOCOL_FEE_WALLET=<fee wallet> \
forge script script/DeployFloatSheets.s.sol --rpc-url rhc --broadcast --account <keystore>
```

Record the addresses and the block in `contracts/deployments/copper-4663.json`, following `goldlake-4663.json`.

**2. Configure the markets, paused.**

```bash
FLOAT_ORACLE_ADDRESS=<copper oracle> FLOAT_CLEARING_HOUSE_ADDRESS=<copper ch> \
forge script script/ConfigureCopperMarkets.s.sol --rpc-url rhc --broadcast --account <keystore>
```

**3. Backend.**
- Set `COPPER_FLOAT_*`, `COPPER_DEPLOYMENT_BLOCK` and `PYTH_API_KEY` (see `backend/.env.example`).
- Deploy. Migration 016 runs on start.
- Check the logs: `reference_market_restricted_unverified_token` must not appear.
- `KEEPER_ENABLED=true` with a funded `KEEPER_PRIVATE_KEY` (or the publisher key): this is what settles the LP queue every day. Look for `vault_epoch_settled` / `vault_epoch_started`.
- Check that `generatedAt` in `rhj/prices` advances. If Robinhood's endpoint lags, tier-2 markets stay close-only.

**4. Watch 24h of marks.** For each market:
- `GET /v1/markets` with header `x-floatsheets-contract-version: copper` shows `sources_used`, `source_dispersion_bps` and `frozen_reason`;
- `reference_quotes` holds every raw quote.

**5. Seed the Copper vault, then go Active.** Seed with team liquidity: add the team wallet to `COPPER_LP_ALLOWLIST`, or deposit straight to the vault contract. The gate to outside LP money stays at audit ≥ 9/10. Then rerun step 2 with `COPPER_MARKET_STATE=1`.

**Weekly (owner):** before each weekend or holiday close (Friday or holiday eve, by 14:00 ET), run step 2 with `COPPER_MARKET_STATE=1 COPPER_LEVERAGE_PROFILE=closure`. After the reopen, run it again with `launch` (or `max`).

**6. After 14 days with zero bad debt.** Run step 2 with `COPPER_MARKET_STATE=1 COPPER_LEVERAGE_PROFILE=max` for 18× / 15×.

**7. More markets.**
- Fund a builder address with ≥ 100 USDC perps account value on Hyperliquid (a venue requirement).
- Set `HYPERLIQUID_BUILDER_ADDRESS` and `OSTIUM_BUILDER_ADDRESS`. Until they're set, `/v1/venues/markets` returns an empty list on purpose (no routed trades without a fee address).
- Claim fees through each venue's referral/builder claim.

**Refreshing the list:**
- Re-pull market caps into `penny-market-caps.json`.
- Run `bun scripts/discover-penny-markets.ts --pools-cache pools.json`.
- Review the generated SQL.
- Swapping a market needs `deregisterMarket` on an empty market first, because the slots are full.

## Risks and limits (read before marketing it)

- **Vault risk is real at 15–18×.**
  - A 15× long is liquidated about 2.7% below the mark, less the opening spread (the quote service keeps at least half that headroom at open).
  - Penny names gap 20–40% overnight. Anything past the margin becomes bad debt on the Copper vault; bad debt pauses new opens on Copper only, and Goldlake has its own vault.
  - The caps ($500–$1,000 per position, contract OI ≤ 15% of the vault per market) bound the loss.
  - Liquidations pause while a market is frozen (halts, held marks), so a halted name that reopens far away can produce bad debt.
- **Frozen exits:** during a halt or a weekend hold, closes cost 7%, and a close that would exceed the margin waits for the reopen. That is the price of not giving losing positions a free exit at a stale mark. `FROZEN_HALF_SPREAD_BPS` is a code constant in `reference.ts`.
- **The closure profile is a manual owner step.** If it's skipped, high-leverage positions opened mid-week ride the weekend gap. The 3× cap only stops new ones.
- **Single-source tier 2:**
  - WYFI, TE and RUN have no public Pyth feed, so they open on Robinhood's quote alone.
  - A stale quote stops opens; a wrong fresh quote would be signed.
  - Keep tier 2 at the launch profile until a second source exists.
- **Data terms:**
  - `rhj/prices` is Robinhood's public token quote endpoint; its terms for commercial reuse are unverified.
  - Check from production that `generatedAt` and the bid/ask actually update: the unchanged-quote check covers a frozen feed, but only after 10 minutes.
  - Pyth Hermes now needs an API key. Confirm the header format with your key (the code sends `Authorization: Bearer`). Without the key, tier-1 markets have one live source and don't open.
- **Venue integrations to verify with one small live order each before announcing** (the shell couldn't reach Hyperliquid's or Ostium's APIs; shapes follow their docs and SDKs and are covered by mocked tests):
  - Ostium's live `openTrade` ABI (it includes `isDayTrade` in the SDK's ABI) and leverage units (assumed ×100);
  - Hyperliquid builder fees on HIP-3 dexes;
  - whether HIP-3 needs USDC moved into the dex.
- **Hyperliquid orders** are signed by a browser agent key kept in `sessionStorage` (gone when the tab closes). It is trade-only (it can't withdraw), replaced after 24h, and approved under one fixed name, so each approval replaces the last. It is re-approved automatically if Hyperliquid says it doesn't exist.
- **Virtual depth:** reference markets report a virtual 250k USDG depth to the shared risk screen; `/v1/markets` shows that number, not a real pool.
- **Still open from the last audit:**
  - Single-EOA owner;
  - signers inside the API process;
  - no timelock (`CONFIG_DELAY = 0`).
  - Copper inherits all three. Don't take outside LP money until they're fixed.
- **US persons:** perps on single US stocks can't be offered to US persons. Geofence Copper and More markets (add a geofence if the site doesn't have one yet).
