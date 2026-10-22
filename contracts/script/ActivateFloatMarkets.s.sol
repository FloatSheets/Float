// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

/// @notice Applies any queued Silverlake market settings immediately, enables oracle
/// markets, and publishes their initial signed marks. Silverlake has zero delay.
contract ActivateFloatMarkets is Script {
    uint64 private constant ORACLE_MAX_AGE = 120;
    uint64 private constant MAX_ORACLE_CONFIDENCE_BPS = 50;

    function run() external {
        FloatOracle oracle = FloatOracle(vm.envAddress("FLOAT_ORACLE_ADDRESS"));
        FloatClearingHouse clearing = FloatClearingHouse(vm.envAddress("FLOAT_CLEARING_HOUSE_ADDRESS"));
        uint256 signerKey = vm.envUint("ORACLE_SIGNER_PRIVATE_KEY");
        uint256 batch = vm.envOr("MARKET_BATCH_INDEX", uint256(0));
        vm.startBroadcast();
        if (batch == 0) {
            _activate(oracle, clearing, signerKey, "NVDA");
            _activate(oracle, clearing, signerKey, "SPCX");
            _activate(oracle, clearing, signerKey, "CRCL");
            _activate(oracle, clearing, signerKey, "HIMS");
        } else if (batch == 1) {
            _activate(oracle, clearing, signerKey, "MU");
            _activate(oracle, clearing, signerKey, "TSLA");
            _activate(oracle, clearing, signerKey, "RDDT");
            _activate(oracle, clearing, signerKey, "MSTR");
        } else if (batch == 2) {
            _activate(oracle, clearing, signerKey, "PLTR");
            _activate(oracle, clearing, signerKey, "QUBT");
        } else {
            revert("invalid market batch");
        }
        vm.stopBroadcast();
    }

    function _activate(FloatOracle oracle, FloatClearingHouse clearing, uint256 signerKey, string memory symbol)
        private
    {
        bytes32 id = keccak256(bytes(symbol));
        uint64 marketAt = clearing.pendingMarketAt(id);
        if (marketAt != 0) clearing.applyMarket(id);
        uint64 oracleAt = oracle.pendingMarketEnableAt(id);
        if (oracleAt != 0) oracle.applyMarketEnabled(id);

        uint256 price = vm.envUint(string.concat("PRICE_", symbol, "_E18"));
        uint256 spot = vm.envUint(string.concat("SPOT_", symbol, "_E18"));
        FloatOracle.Price memory previous = oracle.getPrice(id);
        FloatOracle.PriceAttestation memory attestation = FloatOracle.PriceAttestation({
            marketId: id,
            priceE18: price,
            spotPriceE18: spot,
            confidenceBps: MAX_ORACLE_CONFIDENCE_BPS,
            timestamp: uint64(block.timestamp),
            sequence: previous.sequence + 1,
            expiry: uint64(block.timestamp + ORACLE_MAX_AGE)
        });
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(address(oracle)), _structHash(attestation)));
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

    function _structHash(FloatOracle.PriceAttestation memory a) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "PriceAttestation(bytes32 marketId,uint256 priceE18,uint256 spotPriceE18,uint256 confidenceBps,uint64 timestamp,uint64 sequence,uint64 expiry)"
                ),
                a.marketId,
                a.priceE18,
                a.spotPriceE18,
                a.confidenceBps,
                a.timestamp,
                a.sequence,
                a.expiry
            )
        );
    }
}
