// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

/// @notice Deploys the FloatSheets v1 contracts to Robinhood Chain.
///
/// Required environment variables:
/// - USDG_ADDRESS
/// - ADMIN_EOA_ADDRESS
/// - ORACLE_SIGNER_ADDRESS
/// - QUOTE_SIGNER_ADDRESS
/// - PROTOCOL_FEE_WALLET
/// - ORACLE_MAX_AGE_SECONDS (defaults to 120)
///
/// The deployer must be the admin EOA if the vault link is to be completed in
/// the same transaction sequence. Otherwise, the script still deploys the
/// contracts and prints the one admin-only linking call that remains.
contract DeployFloatSheets is Script {
    uint64 private constant DEFAULT_ORACLE_MAX_AGE_SECONDS = 120;

    function run() external returns (FloatOracle oracle, FloatVault vault, FloatClearingHouse clearingHouse) {
        address usdg = vm.envAddress("USDG_ADDRESS");
        address admin = vm.envAddress("ADMIN_EOA_ADDRESS");
        address oracleSigner = vm.envAddress("ORACLE_SIGNER_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        address feeRecipient = vm.envAddress("PROTOCOL_FEE_WALLET");
        uint64 oracleMaxAge = uint64(vm.envOr("ORACLE_MAX_AGE_SECONDS", uint256(DEFAULT_ORACLE_MAX_AGE_SECONDS)));

        vm.startBroadcast();
        oracle = new FloatOracle(admin, oracleSigner);
        vault = new FloatVault(admin, usdg);
        clearingHouse = new FloatClearingHouse(
            admin, usdg, address(vault), address(oracle), quoteSigner, feeRecipient, oracleMaxAge
        );
        vm.stopBroadcast();

        console2.log("FloatOracle", address(oracle));
        console2.log("FloatVault", address(vault));
        console2.log("FloatClearingHouse", address(clearingHouse));
        console2.log("Admin", admin);
        console2.log("USDG", usdg);
        console2.log("Oracle signer", oracleSigner);
        console2.log("Quote signer", quoteSigner);
        console2.log("Fee recipient", feeRecipient);
        console2.log("Next admin call: vault.setClearingHouse(address(clearingHouse))");
    }
}
