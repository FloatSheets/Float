// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

/// @notice Configures the confirmed v2 markets and publishes initial TWAP/spot marks.
/// Fresh prices are supplied as 18-decimal integers in PRICE_<SYMBOL>_E18 and
/// SPOT_<SYMBOL>_E18 environment variables.
contract ConfigureFloatMarkets is Script {
    error InvalidBatch();

    uint256 private constant E18 = 1e18;
    uint256 private constant USDG_UNIT = 1e6;
    uint64 private constant ORACLE_MAX_AGE = 120;
    uint64 private constant MAX_ORACLE_CONFIDENCE_BPS = 50;
    uint64 private constant MAINTENANCE_MARGIN_BPS = 1_000;

    function run() external {
        FloatOracle oracle = FloatOracle(vm.envAddress("FLOAT_ORACLE_ADDRESS"));
        FloatClearingHouse clearing = FloatClearingHouse(vm.envAddress("FLOAT_CLEARING_HOUSE_ADDRESS"));
        uint256 oracleSignerKey = vm.envUint("ORACLE_SIGNER_PRIVATE_KEY");
        uint256 batch = vm.envOr("MARKET_BATCH_INDEX", uint256(0));

        vm.startBroadcast();
        if (batch == 0) {
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "NVDA",
                1,
                5,
                30,
                50_000,
                vm.envUint("PRICE_NVDA_E18"),
                vm.envUint("SPOT_NVDA_E18")
            );
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "SPCX",
                1,
                5,
                30,
                50_000,
                vm.envUint("PRICE_SPCX_E18"),
                vm.envUint("SPOT_SPCX_E18")
            );
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "CRCL",
                1,
                4,
                80,
                25_000,
                vm.envUint("PRICE_CRCL_E18"),
                vm.envUint("SPOT_CRCL_E18")
            );
            // HIMS is currently beyond the oracle's 50 bps spot/TWAP threshold.
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "HIMS",
                2,
                4,
                80,
                25_000,
                vm.envUint("PRICE_HIMS_E18"),
                vm.envUint("SPOT_HIMS_E18")
            );
        } else if (batch == 1) {
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "MU",
                1,
                3,
                150,
                10_000,
                vm.envUint("PRICE_MU_E18"),
                vm.envUint("SPOT_MU_E18")
            );
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "TSLA",
                1,
                3,
                150,
                10_000,
                vm.envUint("PRICE_TSLA_E18"),
                vm.envUint("SPOT_TSLA_E18")
            );
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "RDDT",
                1,
                2,
                300,
                5_000,
                vm.envUint("PRICE_RDDT_E18"),
                vm.envUint("SPOT_RDDT_E18")
            );
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "MSTR",
                1,
                2,
                300,
                5_000,
                vm.envUint("PRICE_MSTR_E18"),
                vm.envUint("SPOT_MSTR_E18")
            );
        } else if (batch == 2) {
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "PLTR",
                2,
                2,
                500,
                10_000,
                vm.envUint("PRICE_PLTR_E18"),
                vm.envUint("SPOT_PLTR_E18")
            );
            _configure(
                oracle,
                clearing,
                oracleSignerKey,
                "QUBT",
                2,
                2,
                750,
                1_000,
                vm.envUint("PRICE_QUBT_E18"),
                vm.envUint("SPOT_QUBT_E18")
            );
        } else {
            revert InvalidBatch();
        }
        vm.stopBroadcast();
    }

    function _configure(
        FloatOracle oracle,
        FloatClearingHouse clearing,
        uint256 signerKey,
        string memory symbol,
        uint8 state,
        uint256 leverage,
        uint256 executionDeviation,
        uint256 maxPosition,
        uint256 priceE18,
        uint256 spotPriceE18
    ) private {
        bytes32 id = keccak256(bytes(symbol));
        oracle.setMarketEnabled(id, true);
        clearing.setMarket(
            id,
            FloatClearingHouse.Market({
                state: FloatClearingHouse.MarketState(state),
                maxLeverageE18: uint64(leverage * E18),
                maintenanceMarginBps: MAINTENANCE_MARGIN_BPS,
                maxExecutionDeviationBps: uint64(executionDeviation),
                maxOracleConfidenceBps: MAX_ORACLE_CONFIDENCE_BPS,
                maxPositionNotionalUsdg: uint128(maxPosition * USDG_UNIT)
            })
        );

        FloatOracle.Price memory current = oracle.getPrice(id);
        uint64 previousSequence = current.sequence;
        FloatOracle.PriceAttestation memory attestation = FloatOracle.PriceAttestation({
            marketId: id,
            priceE18: priceE18,
            spotPriceE18: spotPriceE18,
            confidenceBps: MAX_ORACLE_CONFIDENCE_BPS,
            timestamp: uint64(block.timestamp),
            sequence: previousSequence + 1,
            expiry: uint64(block.timestamp + ORACLE_MAX_AGE)
        });
        _publish(oracle, signerKey, attestation);
    }

    function _publish(FloatOracle oracle, uint256 signerKey, FloatOracle.PriceAttestation memory attestation) private {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PriceAttestation(bytes32 marketId,uint256 priceE18,uint256 spotPriceE18,uint256 confidenceBps,uint64 timestamp,uint64 sequence,uint64 expiry)"
                ),
                attestation.marketId,
                attestation.priceE18,
                attestation.spotPriceE18,
                attestation.confidenceBps,
                attestation.timestamp,
                attestation.sequence,
                attestation.expiry
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(address(oracle)), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        oracle.publish(attestation, abi.encodePacked(r, s, v));
    }

    function _domain(address verifyingContract) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("FloatSheetsOracle"),
                keccak256("1"),
                block.chainid,
                verifyingContract
            )
        );
    }
}
