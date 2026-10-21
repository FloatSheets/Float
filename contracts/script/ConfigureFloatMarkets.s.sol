// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

/// @notice Registers Amber launch markets immediately. Any scheduled market or
/// oracle change can be applied immediately because configuration delay is zero.
contract ConfigureFloatMarkets is Script {
    error InvalidBatch();

    uint256 private constant E18 = 1e18;
    uint256 private constant USDG_UNIT = 1e6;
    uint64 private constant MAX_ORACLE_CONFIDENCE_BPS = 50;
    uint64 private constant MAINTENANCE_MARGIN_BPS = 1_000;

    function run() external {
        FloatOracle oracle = FloatOracle(vm.envAddress("FLOAT_ORACLE_ADDRESS"));
        FloatClearingHouse clearing = FloatClearingHouse(vm.envAddress("FLOAT_CLEARING_HOUSE_ADDRESS"));
        uint256 batch = vm.envOr("MARKET_BATCH_INDEX", uint256(0));

        vm.startBroadcast();
        if (batch == 0) {
            _configure(oracle, clearing, "NVDA", 1, 5, 30, 50_000);
            _configure(oracle, clearing, "SPCX", 1, 5, 30, 50_000);
            _configure(oracle, clearing, "CRCL", 1, 4, 80, 25_000);
            // HIMS is currently beyond the oracle's 50 bps spot/TWAP threshold.
            _configure(oracle, clearing, "HIMS", 2, 4, 80, 25_000);
        } else if (batch == 1) {
            _configure(oracle, clearing, "MU", 1, 3, 150, 10_000);
            _configure(oracle, clearing, "TSLA", 1, 3, 150, 10_000);
            _configure(oracle, clearing, "RDDT", 1, 2, 300, 5_000);
            _configure(oracle, clearing, "MSTR", 1, 2, 300, 5_000);
        } else if (batch == 2) {
            _configure(oracle, clearing, "PLTR", 2, 2, 500, 10_000);
            _configure(oracle, clearing, "QUBT", 2, 2, 750, 1_000);
        } else {
            revert InvalidBatch();
        }
        vm.stopBroadcast();
    }

    function _configure(
        FloatOracle oracle,
        FloatClearingHouse clearing,
        string memory symbol,
        uint8 state,
        uint256 leverage,
        uint256 executionDeviation,
        uint256 maxPosition
    ) private {
        bytes32 id = keccak256(bytes(symbol));
        FloatClearingHouse.Market memory market = FloatClearingHouse.Market({
            state: FloatClearingHouse.MarketState(state),
            maxLeverageE18: uint64(leverage * E18),
            maintenanceMarginBps: MAINTENANCE_MARGIN_BPS,
            maxExecutionDeviationBps: uint64(executionDeviation),
            maxOracleConfidenceBps: MAX_ORACLE_CONFIDENCE_BPS,
            maxPositionNotionalUsdg: uint128(maxPosition * USDG_UNIT)
        });
        if (clearing.getMarket(id).state == FloatClearingHouse.MarketState.Unset) {
            clearing.registerMarket(id, market);
        } else {
            clearing.setMarket(id, market);
            if (clearing.pendingMarketAt(id) != 0) clearing.applyMarket(id);
        }
        if (!oracle.marketEverEnabled(id)) {
            oracle.enableInitialMarket(id);
        } else {
            oracle.setMarketEnabled(id, true);
            if (oracle.pendingMarketEnableAt(id) != 0) oracle.applyMarketEnabled(id);
        }
    }
}
