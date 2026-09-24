// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FloatOracle} from "../src/FloatOracle.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4) external;
}

contract FloatOracleTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SIGNER_KEY = 0xA11CE;
    bytes32 private constant MARKET = keccak256("NVDA-PERP");
    FloatOracle private oracle;

    function setUp() public {
        oracle = new FloatOracle(address(this), vm.addr(SIGNER_KEY));
        oracle.setMarketEnabled(MARKET, true);
    }

    function testPublishesValidAttestation() public {
        FloatOracle.PriceAttestation memory a = _attestation(1, uint64(block.timestamp + 60));
        oracle.publish(a, _signature(a));
        FloatOracle.Price memory price = oracle.getPrice(MARKET);
        require(price.priceE18 == a.priceE18, "price");
        require(price.sequence == 1, "sequence");
        require(!price.circuitBroken, "breaker");
    }

    function testRecordsSpotTwapCircuitBreaker() public {
        FloatOracle.PriceAttestation memory a = _attestation(1, uint64(block.timestamp + 60));
        a.spotPriceE18 = 230e18;
        oracle.publish(a, _signature(a));
        FloatOracle.Price memory price = oracle.getPrice(MARKET);
        require(price.circuitBroken, "breaker not set");
        require(price.spotTwapDeviationBps > 50, "deviation");
    }

    function testRejectsZeroSpotPrice() public {
        FloatOracle.PriceAttestation memory a = _attestation(1, uint64(block.timestamp + 60));
        a.spotPriceE18 = 0;
        vm.expectRevert(FloatOracle.InvalidPrice.selector);
        oracle.publish(a, _signature(a));
    }

    function testRejectsReplay() public {
        FloatOracle.PriceAttestation memory a = _attestation(1, uint64(block.timestamp + 60));
        bytes memory sig = _signature(a);
        oracle.publish(a, sig);
        vm.expectRevert(FloatOracle.InvalidSequence.selector);
        oracle.publish(a, sig);
    }

    function testRejectsExpiredAttestation() public {
        FloatOracle.PriceAttestation memory a = _attestation(1, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 2);
        vm.expectRevert(FloatOracle.AttestationExpired.selector);
        oracle.publish(a, _signature(a));
    }

    function testRejectsDisabledMarket() public {
        oracle.setMarketEnabled(MARKET, false);
        FloatOracle.PriceAttestation memory a = _attestation(1, uint64(block.timestamp + 60));
        vm.expectRevert(FloatOracle.MarketDisabled.selector);
        oracle.publish(a, _signature(a));
    }

    function testRejectsWrongSigner() public {
        FloatOracle.PriceAttestation memory a = _attestation(1, uint64(block.timestamp + 60));
        bytes32 digest = _digest(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, digest);
        vm.expectRevert(FloatOracle.InvalidSignature.selector);
        oracle.publish(a, abi.encodePacked(r, s, v));
    }

    function _attestation(uint64 sequence, uint64 expiry) private view returns (FloatOracle.PriceAttestation memory) {
        return FloatOracle.PriceAttestation(MARKET, 228e18, 228e18, 50, uint64(block.timestamp), sequence, expiry);
    }

    function _signature(FloatOracle.PriceAttestation memory a) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, _digest(a));
        return abi.encodePacked(r, s, v);
    }

    function _digest(FloatOracle.PriceAttestation memory a) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("FloatSheetsOracle"),
                keccak256("1"),
                block.chainid,
                address(oracle)
            )
        );
        bytes32 structHash = keccak256(
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
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
}
