// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

/// @notice Configures the FloatSheets Copper release: the 10 lowest-market-cap
///         official Robinhood Stock Tokens (snapshot 2026-10-22: WYFI, NNE, RCAT, TE,
///         XNDU, POET, FLNC, QUBT, RUN, DJT), on their own oracle, instant-liquidity
///         vault and clearing house. Deploy the contract set first with
///         DeployCopper.s.sol, then run this script. The contracts are the existing
///         audited code; only the market parameters below are Copper-specific.
///
/// Environment:
/// - FLOAT_ORACLE_ADDRESS, FLOAT_CLEARING_HOUSE_ADDRESS: the Copper contracts
/// - COPPER_MARKET_STATE: 3 = Paused (default, first run), 1 = Active (after 24h of clean marks)
/// - COPPER_LEVERAGE_PROFILE: "launch" (default), "step-up" (after 14 days without bad debt) or
///   "closure" (3x, 25% maintenance) to run before every weekend/holiday closure: positions
///   above 3x must add margin or are liquidated by the keeper at the live price before the
///   market freezes. Run "launch" again after the reopen.
///
/// Leverage profiles (maintenance margin must stay below 1 / leverage). Penny names
/// gap 20-40% overnight, so launch is conservative: a 5x position with 5% maintenance
/// is liquidated after roughly a 15% adverse move.
///   tier 1 (two live price sources): launch 5x / 5.0% MM, step-up 10x / 6.0% MM, $1,000 cap
///   tier 2 (one live price source):  launch 5x / 5.0% MM, step-up 5x / 5.0% MM, $500 cap
/// The oracle is the unmodified FloatOracle (50 bps spot/TWAP band, 20% jump guard).
/// Reference prices publish spot equal to the mark, so the band never freezes them;
/// gaps above 20% are walked in 19% steps by the backend publisher.
contract ConfigureCopperMarkets is Script {
    bool private closureProfile;
    uint256 private constant E18 = 1e18;
    uint256 private constant USDG_UNIT = 1e6;
    uint64 private constant MAX_ORACLE_CONFIDENCE_BPS = 50;
    // The protocol hard bound; spreads are set off-chain from live quotes.
    uint64 private constant MAX_EXECUTION_DEVIATION_BPS = 750;

    function run() external {
        FloatOracle oracle = FloatOracle(vm.envAddress("FLOAT_ORACLE_ADDRESS"));
        FloatClearingHouse clearing = FloatClearingHouse(vm.envAddress("FLOAT_CLEARING_HOUSE_ADDRESS"));
        uint8 state = uint8(vm.envOr("COPPER_MARKET_STATE", uint256(3)));
        bytes32 profile = keccak256(bytes(vm.envOr("COPPER_LEVERAGE_PROFILE", string("launch"))));
        require(profile == keccak256("launch") || profile == keccak256("step-up") || profile == keccak256("closure"), "unknown profile");
        bool stepUp = profile == keccak256("step-up");
        closureProfile = profile == keccak256("closure");
        require(state == 1 || state == 2 || state == 3, "COPPER_MARKET_STATE must be 1, 2 or 3");

        vm.startBroadcast();
        // Tier 1: Robinhood reference price plus an independent Pyth equity feed.
        _configure(oracle, clearing, "RCAT", state, 1, stepUp);
        _configure(oracle, clearing, "NNE", state, 1, stepUp);
        _configure(oracle, clearing, "XNDU", state, 1, stepUp);
        _configure(oracle, clearing, "POET", state, 1, stepUp);
        _configure(oracle, clearing, "FLNC", state, 1, stepUp);
        _configure(oracle, clearing, "QUBT", state, 1, stepUp);
        _configure(oracle, clearing, "DJT", state, 1, stepUp);
        // Tier 2: Robinhood reference price only (no public Pyth feed found).
        _configure(oracle, clearing, "WYFI", state, 2, stepUp);
        _configure(oracle, clearing, "TE", state, 2, stepUp);
        _configure(oracle, clearing, "RUN", state, 2, stepUp);
        vm.stopBroadcast();
    }

    function _configure(
        FloatOracle oracle,
        FloatClearingHouse clearing,
        string memory symbol,
        uint8 state,
        uint8 tier,
        bool stepUp
    ) private {
        bytes32 id = keccak256(bytes(symbol));
        (uint256 leverage, uint64 maintenance, uint256 cap) = closureProfile
            ? (3, uint64(2_500), tier == 1 ? uint256(1_000) : uint256(500))
            : tier == 1
            ? (stepUp ? (10, uint64(600), uint256(1_000)) : (5, uint64(500), uint256(1_000)))
            : (5, uint64(500), uint256(500));
        FloatClearingHouse.Market memory market = FloatClearingHouse.Market({
            state: FloatClearingHouse.MarketState(state),
            maxLeverageE18: uint64(leverage * E18),
            maintenanceMarginBps: maintenance,
            maxExecutionDeviationBps: MAX_EXECUTION_DEVIATION_BPS,
            maxOracleConfidenceBps: MAX_ORACLE_CONFIDENCE_BPS,
            maxPositionNotionalUsdg: uint128(cap * USDG_UNIT)
        });
        if (clearing.getMarket(id).state == FloatClearingHouse.MarketState.Unset) {
            clearing.registerMarket(id, market);
        } else {
            clearing.setMarket(id, market);
            if (clearing.pendingMarketAt(id) != 0) clearing.applyMarket(id);
        }
        if (!oracle.marketEverEnabled(id)) {
            oracle.enableInitialMarket(id);
        } else if (!oracle.marketEnabled(id)) {
            oracle.setMarketEnabled(id, true);
            if (oracle.pendingMarketEnableAt(id) != 0) oracle.applyMarketEnabled(id);
        }
        console2.log(symbol, leverage, maintenance, cap);
    }
}
