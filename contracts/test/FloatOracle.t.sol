// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FloatOracle} from "../src/FloatOracle.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
    function prank(address) external;
    function applyMarketEnabled(bytes32 marketId) external;
    function expectRevert(bytes4) external;
}

contract FloatOracleTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SIGNER_KEY = 0xA11CE;
    bytes32 private constant MARKET = keccak256("NVDA-PERP");
    bytes32 private constant LAUNCH_MARKET = keccak256("CRCL-PERP");
    FloatOracle private oracle;

    function setUp() public {
        oracle = new FloatOracle(address(this), vm.addr(SIGNER_KEY));
        oracle.setMarketEnabled(MARKET, true);
        vm.warp(block.timestamp + 48 hours);
        oracle.applyMarketEnabled(MARKET);
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

    function testConstructorAndFutureTimestampValidation() public {
        vm.expectRevert(FloatOracle.ZeroAddress.selector);
        new FloatOracle(address(0), vm.addr(SIGNER_KEY));
        vm.expectRevert(FloatOracle.ZeroAddress.selector);
        new FloatOracle(address(this), address(0));

        FloatOracle.PriceAttestation memory a = _attestation(1, uint64(block.timestamp + 60));
        a.timestamp = uint64(block.timestamp + 1);
        vm.expectRevert(FloatOracle.InvalidTimestamp.selector);
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

    function testLargePriceJumpTripsBreakerWithoutReplacingLastGoodPrice() public {
        FloatOracle.PriceAttestation memory first = _attestation(1, uint64(block.timestamp + 60));
        oracle.publish(first, _signature(first));
        FloatOracle.PriceAttestation memory jump = _attestation(2, uint64(block.timestamp + 60));
        jump.priceE18 = 300e18;
        jump.spotPriceE18 = 300e18;
        oracle.publish(jump, _signature(jump));
        FloatOracle.Price memory held = oracle.getPrice(MARKET);
        require(held.priceE18 == first.priceE18 && held.circuitBroken, "jump was not quarantined");
        FloatOracle.PriceAttestation memory recovered = _attestation(3, uint64(block.timestamp + 60));
        recovered.priceE18 = 230e18;
        recovered.spotPriceE18 = 230e18;
        oracle.publish(recovered, _signature(recovered));
        require(!oracle.getPrice(MARKET).circuitBroken, "stable price did not recover");
    }

    function testOracleSignerRotationAppliesImmediately() public {
        address nextSigner = vm.addr(0xB0B);
        oracle.setSigner(nextSigner);
        require(oracle.signer() == vm.addr(SIGNER_KEY), "signer changed early");
        uint256 scheduledAt = block.timestamp;
        vm.warp(scheduledAt - 1);
        vm.expectRevert(FloatOracle.TimelockNotReady.selector);
        oracle.applySigner();
        vm.warp(scheduledAt);
        oracle.applySigner();
        require(oracle.signer() == nextSigner, "signer not rotated");
        vm.expectRevert(FloatOracle.NoPendingChange.selector);
        oracle.applySigner();
    }

    function testOracleMarketReenableAppliesImmediately() public {
        oracle.setMarketEnabled(MARKET, false);
        oracle.setMarketEnabled(MARKET, true);
        uint256 scheduledAt = block.timestamp;
        vm.warp(scheduledAt - 1);
        vm.expectRevert(FloatOracle.TimelockNotReady.selector);
        oracle.applyMarketEnabled(MARKET);
        vm.warp(scheduledAt);
        oracle.applyMarketEnabled(MARKET);
        require(oracle.marketEnabled(MARKET), "market not enabled");
    }

    function testFirstOracleEnableForLaunchIsImmediateAndOneTime() public {
        oracle.enableInitialMarket(LAUNCH_MARKET);
        require(oracle.marketEnabled(LAUNCH_MARKET), "launch market not enabled");
        require(oracle.marketEverEnabled(LAUNCH_MARKET), "launch enable not recorded");
        vm.expectRevert(FloatOracle.NoPendingChange.selector);
        oracle.enableInitialMarket(LAUNCH_MARKET);
    }

    function testRejectsMalformedSignatures() public {
        FloatOracle.PriceAttestation memory a = _attestation(1, uint64(block.timestamp + 60));
        vm.expectRevert(FloatOracle.InvalidSignature.selector);
        oracle.publish(a, hex"1234");

        bytes memory invalidV = new bytes(65);
        invalidV[64] = bytes1(uint8(29));
        vm.expectRevert(FloatOracle.InvalidSignature.selector);
        oracle.publish(a, invalidV);

        bytes memory normalizedV = new bytes(65);
        normalizedV[64] = bytes1(uint8(0));
        vm.expectRevert(FloatOracle.InvalidSignature.selector);
        oracle.publish(a, normalizedV);

        bytes memory highS = new bytes(65);
        for (uint256 i; i < 32; ++i) {
            highS[32 + i] = bytes1(uint8(0xff));
        }
        highS[64] = bytes1(uint8(27));
        vm.expectRevert(FloatOracle.InvalidSignature.selector);
        oracle.publish(a, highS);
    }

    function testOracleOwnerAndMarketEnableControls() public {
        vm.expectRevert(FloatOracle.ZeroAddress.selector);
        oracle.setSigner(address(0));
        vm.expectRevert(FloatOracle.ZeroAddress.selector);
        oracle.scheduleOwnershipTransfer(address(0));
        vm.expectRevert(FloatOracle.Unauthorized.selector);
        vm.prank(address(0xBEEF));
        oracle.setSigner(address(0xCAFE));

        oracle.setMarketEnabled(MARKET, true);
        oracle.setMarketEnabled(MARKET, false);
        require(oracle.pendingMarketEnableAt(MARKET) == 0, "pending enable not cancelled");
        vm.expectRevert(FloatOracle.NoPendingChange.selector);
        oracle.applyMarketEnabled(MARKET);

        address nextOwner = vm.addr(0xCAFE);
        oracle.scheduleOwnershipTransfer(nextOwner);
        uint256 scheduledAt = block.timestamp;
        vm.warp(scheduledAt - 1);
        vm.expectRevert(FloatOracle.TimelockNotReady.selector);
        vm.prank(nextOwner);
        oracle.acceptOwnership();
        vm.warp(scheduledAt);
        vm.prank(nextOwner);
        oracle.acceptOwnership();
        require(oracle.owner() == nextOwner, "ownership not transferred");
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
