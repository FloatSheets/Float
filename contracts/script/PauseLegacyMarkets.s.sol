// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";

interface IRetiredClearingHouse {
    struct Market {
        uint8 state;
        uint64 maxLeverageE18;
        uint64 maintenanceMarginBps;
        uint64 maxExecutionDeviationBps;
        uint64 maxOracleConfidenceBps;
        uint128 maxPositionNotionalUsdg;
    }

    function marketCount() external view returns (uint256);
    function marketIdAt(uint256 index) external view returns (bytes32);
    function markets(bytes32 marketId) external view returns (Market memory);
    function setMarket(bytes32 marketId, Market calldata market) external;
}

/// @notice Immediately pauses new risk in Jasper and Meadow. Existing users can
/// still submit risk-reducing closes and withdraw liquidity.
contract PauseLegacyMarkets is Script {
    uint8 private constant PAUSED = 3;

    function run() external {
        IRetiredClearingHouse jasper = IRetiredClearingHouse(vm.envAddress("JASPER_FLOAT_CLEARING_HOUSE_ADDRESS"));
        IRetiredClearingHouse meadow = IRetiredClearingHouse(vm.envAddress("MEADOW_FLOAT_CLEARING_HOUSE_ADDRESS"));
        vm.startBroadcast();
        _pause(jasper);
        _pause(meadow);
        vm.stopBroadcast();
    }

    function _pause(IRetiredClearingHouse clearing) private {
        uint256 count = clearing.marketCount();
        for (uint256 i; i < count; ++i) {
            bytes32 id = clearing.marketIdAt(i);
            IRetiredClearingHouse.Market memory market = clearing.markets(id);
            if (market.state == PAUSED) continue;
            market.state = PAUSED;
            clearing.setMarket(id, market);
        }
    }
}
