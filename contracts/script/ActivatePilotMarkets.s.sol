// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

/// @notice Enables new positions on Goldlake for the three pilot markets while
/// preserving their existing on-chain risk limits. The OraclePublisher will
/// publish the first fresh marks on demand after this script is broadcast.
contract ActivatePilotMarkets is Script {
    function run() external {
        FloatOracle oracle = FloatOracle(vm.envAddress("FLOAT_ORACLE_ADDRESS"));
        FloatClearingHouse clearing = FloatClearingHouse(vm.envAddress("FLOAT_CLEARING_HOUSE_ADDRESS"));

        vm.startBroadcast();
        _activate(oracle, clearing, "QUBT");
        _activate(oracle, clearing, "HIMS");
        _activate(oracle, clearing, "PLTR");
        vm.stopBroadcast();
    }

    function _activate(FloatOracle oracle, FloatClearingHouse clearing, string memory symbol) private {
        bytes32 id = keccak256(bytes(symbol));

        uint64 marketAt = clearing.pendingMarketAt(id);
        if (marketAt != 0) clearing.applyMarket(id);

        FloatClearingHouse.Market memory market = clearing.getMarket(id);
        if (market.state != FloatClearingHouse.MarketState.Active) {
            market.state = FloatClearingHouse.MarketState.Active;
            clearing.setMarket(id, market);
            if (clearing.pendingMarketAt(id) != 0) clearing.applyMarket(id);
        }

        uint64 oracleAt = oracle.pendingMarketEnableAt(id);
        if (oracleAt != 0) oracle.applyMarketEnabled(id);
        if (!oracle.marketEnabled(id)) {
            if (!oracle.marketEverEnabled(id)) {
                oracle.enableInitialMarket(id);
            } else {
                oracle.setMarketEnabled(id, true);
                if (oracle.pendingMarketEnableAt(id) != 0) oracle.applyMarketEnabled(id);
            }
        }
    }
}
