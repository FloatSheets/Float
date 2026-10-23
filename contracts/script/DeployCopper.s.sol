// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatInstantVault} from "../src/FloatInstantVault.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

/// @notice Deploys the Copper penny-stock protocol set. Same audited contracts as
/// Jaguar (FloatOracle, FloatInstantVault, FloatClearingHouse) at new addresses,
/// so penny-stock risk sits in its own vault. Configure markets with
/// ConfigureCopperMarkets.s.sol afterwards.
contract DeployCopper is Script {
    uint64 private constant DEFAULT_ORACLE_MAX_AGE_SECONDS = 120;

    function run() external returns (FloatOracle oracle, FloatInstantVault vault, FloatClearingHouse clearingHouse) {
        address usdg = vm.envAddress("USDG_ADDRESS");
        address owner = vm.envAddress("OWNER_EOA_ADDRESS");
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address oracleSigner = vm.envAddress("ORACLE_SIGNER_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        address feeRecipient = vm.envAddress("PROTOCOL_FEE_WALLET");
        uint64 oracleMaxAge = uint64(vm.envOr("ORACLE_MAX_AGE_SECONDS", uint256(DEFAULT_ORACLE_MAX_AGE_SECONDS)));

        if (owner != deployer) revert("deployer must be the initial owner");
        vm.startBroadcast();
        oracle = new FloatOracle(owner, oracleSigner);
        vault = new FloatInstantVault(owner, usdg);
        // FloatClearingHouse uses the FloatVault ABI for its immutable vault
        // handle. FloatInstantVault implements the same accounting and settlement ABI.
        clearingHouse = new FloatClearingHouse(
            owner, usdg, address(vault), address(oracle), quoteSigner, feeRecipient, oracleMaxAge
        );
        vault.setClearingHouse(address(clearingHouse));
        vm.stopBroadcast();

        console2.log("Copper FloatOracle", address(oracle));
        console2.log("Copper FloatInstantVault", address(vault));
        console2.log("Copper FloatClearingHouse", address(clearingHouse));
        console2.log("Owner and deployer", owner);
        console2.log("USDG", usdg);
        console2.log("Oracle signer", oracleSigner);
        console2.log("Quote signer", quoteSigner);
        console2.log("Fee recipient", feeRecipient);
    }
}
