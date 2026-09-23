# FloatSheets v1 audit-readiness gate

This document is the scope gate for an audit of the USDG-settled, pool-vs-trader protocol on Robinhood Chain. It is not an audit report and does not authorize deployment.

## Current implementation

- `FloatOracle` accepts EIP-712 price attestations from a configured signer and stores a sequence-monotonic price per market.
- `FloatVault` accepts USDG liquidity and permits the clearing house to collect losses or pay trader profits.
- `FloatClearingHouse` holds isolated trader margin, accepts EIP-712 quotes bound to a trader and this contract, tracks one net position per trader/market, and performs full liquidation below maintenance margin.

## Locked v1 decisions

- **Settlement and margin:** USDG only; one shared LP vault; isolated trader margin per market.
- **Funding:** zero funding in v1. No periodic long/short transfer is accrued or settled.
- **Liquidation:** full liquidation only. A position below maintenance margin is completely closed at the latest valid oracle price.
- **Liquidation incentive:** a 5% penalty is charged from remaining margin where available: 2.5% to the permissionless liquidator and 2.5% to the LP vault. The exact rounding and insufficient-margin behavior must be defined in code and tests.
- **Market states:** `active` permits all valid actions; `close_only` permits only risk-reducing trades, margin withdrawal when safe, and liquidation; `paused` blocks user trading while preserving the documented exit/emergency procedure.
- **Initial caps:** 50% vault utilization, 15% gross OI per market, and 10% absolute directional skew per market, all measured against vault assets. LP withdrawals reserve 100% of gross OI at current oracle prices; net skew is a separate directional-risk cap and cannot be used as the withdrawal reserve.
- **Price policy:** direct Uniswap V3 stock/USDG 30-minute TWAP; at most 120 seconds old on-chain; circuit-break to `close_only` when current pool spot differs from TWAP by more than 50 bps; signed quote execution price is bounded by the market's configured maximum deviation from the attested price.
- **Administration:** the temporary EOA may manage markets, bounded risk parameters, market state, and signers. It cannot transfer LP vault assets or trader margin.
- **Bad debt:** v1 has no external insurance fund. A trader's loss is capped at their isolated margin; any shortfall is a loss to the shared vault and therefore reflected in LP share value. The utilization/reserve model must bound this risk before an open or increase is accepted.

## Remaining design details

These values and behaviors must be chosen, documented, and implemented before the code can be frozen for audit:

1. **LP liquidity protection:** define the conservative reserve formula and withdrawal behavior while positions are open. The current vault values shares from its token balance alone, so it does not reserve for unrealized trader profit or bankruptcy exposure.
2. **Cap accounting:** define the conservative measurement method for utilization, OI, and skew as prices move between trades.
3. **Liquidation boundary:** select the per-market maintenance-margin values and define penalty rounding when margin is insufficient.
4. **Oracle circuit breaker:** define the on-chain attestation fields and backend computation that prove the 50-bps spot/TWAP condition.
5. **Administration:** list every EOA-controlled function, its expected emergency use, and the user exit path under `paused`.

## Required implementation work

- Make vault liabilities explicit and enforce withdrawal limits derived from the chosen reserve model.
- Add market state transitions and risk-reducing close behavior.
- Add global and per-market exposure accounting plus the chosen caps.
- Implement the chosen liquidation fee/keeper and bad-debt path.
- Validate the vault's settlement asset and clearing-house linkage at deployment.
- Provide deployment scripts and one immutable market-configuration manifest for Robinhood Chain.
- Add contract events and read functions required for protocol accounting and the backend indexer.

## Required verification

The final test suite must cover real USDG behavior on a Robinhood Chain fork, alongside deterministic Foundry property tests:

- LP deposits, withdrawals, share accounting, vault solvency, profits, losses, and bad debt.
- Long/short opens, increases, partial closes, full closes, reversals, fees, and rounding at USDG's six decimals.
- Initial and maintenance margin boundaries, margin withdrawals, full liquidation, keeper reward, and bankruptcy.
- Market state transitions, risk caps, quote expiry/replay/caller binding, oracle expiry/sequence/signature/confidence/deviation checks.
- Invariants: no user can withdraw collateral securing an open position; all vault asset movement is accounted for; a position cannot exceed configured risk; quote nonces are single-use; protocol liabilities are bounded by the configured reserve model.

## Freeze condition

Audit begins only after the protocol decisions above are committed to a specification, the contracts and backend agree with that specification, all tests and static analysis pass, deployment configuration is reproducible, and the scoped commit is tagged. Functional changes after that point restart the affected audit area.
