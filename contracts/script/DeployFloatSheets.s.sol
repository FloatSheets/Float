// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

/// @notice Deploys a new immutable FloatSheets Silverlake contract set to Robinhood Chain.
///
/// Required environment variables:
/// - USDG_ADDRESS
/// - OWNER_EOA_ADDRESS
/// - DEPLOYER_ADDRESS
/// - ORACLE_SIGNER_ADDRESS
/// - QUOTE_SIGNER_ADDRESS
/// - PROTOCOL_FEE_WALLET
/// - ORACLE_MAX_AGE_SECONDS (defaults to 120)
///
/// When OWNER_EOA_ADDRESS equals DEPLOYER_ADDRESS, the script completes the
/// vault-to-clearing-house link in the same broadcast.
contract DeployFloatSheets is Script {
    uint64 private constant DEFAULT_ORACLE_MAX_AGE_SECONDS = 120;

    function run() external returns (FloatOracle oracle, FloatVault vault, FloatClearingHouse clearingHouse) {
        address usdg = vm.envAddress("USDG_ADDRESS");
        address owner = vm.envAddress("OWNER_EOA_ADDRESS");
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address oracleSigner = vm.envAddress("ORACLE_SIGNER_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        address feeRecipient = vm.envAddress("PROTOCOL_FEE_WALLET");
        uint64 oracleMaxAge = uint64(vm.envOr("ORACLE_MAX_AGE_SECONDS", uint256(DEFAULT_ORACLE_MAX_AGE_SECONDS)));

        if (owner != deployer) revert("deployer must be the initial owner");
        // Sign with the CLI-selected keystore or hardware wallet. This keeps the
        // deployer secret out of process environment variables and script logs.
        vm.startBroadcast();
        oracle = new FloatOracle(owner, oracleSigner);
        vault = new FloatVault(owner, usdg);
        clearingHouse = new FloatClearingHouse(
            owner, usdg, address(vault), address(oracle), quoteSigner, feeRecipient, oracleMaxAge
        );
        if (owner == deployer) vault.setClearingHouse(address(clearingHouse));
        vm.stopBroadcast();

        console2.log("FloatOracle", address(oracle));
        console2.log("FloatVault", address(vault));
        console2.log("FloatClearingHouse", address(clearingHouse));
        console2.log("Owner", owner);
        console2.log("Deployer", deployer);
        console2.log("USDG", usdg);
        console2.log("Oracle signer", oracleSigner);
        console2.log("Quote signer", quoteSigner);
        console2.log("Fee recipient", feeRecipient);
        if (owner != deployer) console2.log("Owner must call vault.setClearingHouse(address(clearingHouse))");
    }
}
