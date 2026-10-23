// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";
import {MockUsdG} from "./FloatSecurity.t.sol";

/// @notice Copper (penny-stock) release: small, conservatively levered markets on their
///         own vault. Uses the unchanged oracle, clearing house and vault code.
contract CopperReleaseTest is Test {
    uint256 private constant USDG = 1e6;
    uint256 private constant E18 = 1e18;
    uint256 private constant ORACLE_KEY = 0xA11CE;
    uint256 private constant QUOTE_KEY = 0xB0B;
    bytes32 private constant PENNY = keccak256("RCAT");
    address private constant TRADER = address(0x1111);
    address private constant TRADER_TWO = address(0x3333);

    MockUsdG private token;
    FloatOracle private oracle;
    FloatVault private vault;
    FloatClearingHouse private clearing;
    uint64 private sequence;

    function setUp() public {
        token = new MockUsdG();
        oracle = new FloatOracle(address(this), vm.addr(ORACLE_KEY));
        vault = new FloatVault(address(this), address(token));
        clearing = new FloatClearingHouse(
            address(this), address(token), address(vault), address(oracle), vm.addr(QUOTE_KEY), address(this), 120
        );
        vault.setClearingHouse(address(clearing));
        // Copper launch parameters (see ConfigureCopperMarkets.s.sol).
        clearing.registerMarket(PENNY, _market(5, 500));
        oracle.enableInitialMarket(PENNY);

        token.mint(address(this), 200_000 * USDG);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(200_000 * USDG, address(this));
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        _publish(5 * E18, 5 * E18);
        vault.settleQueue();
        vault.claimDeposit(vault.queueEpoch());
        vault.startNextQueueEpoch();
        for (uint256 i; i < 2; ++i) {
            address trader = i == 0 ? TRADER : TRADER_TWO;
            token.mint(trader, 10_000 * USDG);
            vm.prank(trader);
            token.approve(address(clearing), type(uint256).max);
        }
    }

    function testEighteenTimesIsTheHighestRepresentableLeverage() public {
        // maxLeverageE18 is a uint64: 18.44e18 is the ceiling.
        assertLt(uint256(type(uint64).max), 19 * E18);
        clearing.setMarket(PENNY, _market(18, 300));
        // Loosening is scheduled, then applied (CONFIG_DELAY is zero on this release).
        clearing.applyMarket(PENNY);
        assertEq(clearing.getMarket(PENNY).maxLeverageE18, 18 * E18);
        // Maintenance margin must stay below 1 / leverage.
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(PENNY, _market(18, 560));
    }

    function testFiveTimesLongOpensWithTwentyPercentMargin() public {
        // $1,000 notional at 5x needs $200 margin plus the 6 bps fee.
        vm.prank(TRADER);
        clearing.depositMargin(PENNY, 201 * USDG);
        _execute(TRADER, int256(200 * E18), 5 * E18, 1);
        assertEq(clearing.getPosition(TRADER, PENNY).sizeE18, int256(200 * E18));
    }

    function testLaunchProfileRefusesMoreThanFiveTimes() public {
        vm.prank(TRADER);
        clearing.depositMargin(PENNY, 190 * USDG);
        FloatClearingHouse.TradeQuote memory quote = _quote(TRADER, int256(200 * E18), 5 * E18, 1);
        bytes memory sig = _sign(quote);
        vm.prank(TRADER);
        vm.expectRevert(FloatClearingHouse.InsufficientMargin.selector);
        clearing.execute(quote, sig);
    }

    function testReferenceMarksLiquidateWithoutTrippingTheBand() public {
        vm.prank(TRADER);
        clearing.depositMargin(PENNY, 201 * USDG);
        _execute(TRADER, int256(200 * E18), 5 * E18, 1);
        // A 16% fall. Reference prices publish spot equal to the mark, so the stock
        // 50 bps spot/TWAP band stays clear and the keeper can liquidate.
        _publish(4.2e18, 4.2e18);
        assertFalse(oracle.getPrice(PENNY).circuitBroken);
        clearing.liquidate(TRADER, PENNY);
        assertEq(clearing.getPosition(TRADER, PENNY).sizeE18, 0);
        assertEq(clearing.badDebtUsdg(), 0);
    }

    function testGapAboveTheJumpGuardIsWalkedInSteps() public {
        vm.prank(TRADER);
        clearing.depositMargin(PENNY, 201 * USDG);
        _execute(TRADER, int256(200 * E18), 5 * E18, 1);
        // A 30% gap in one attestation is quarantined: the last good price is kept.
        _publish(3.5e18, 3.5e18);
        assertTrue(oracle.getPrice(PENNY).circuitBroken);
        assertEq(oracle.getPrice(PENNY).priceE18, 5 * E18);
        // The publisher walks it in 19% steps instead: each step is a clean mark.
        _publish(4.05e18, 4.05e18);
        assertFalse(oracle.getPrice(PENNY).circuitBroken);
        _publish(3.5e18, 3.5e18);
        assertFalse(oracle.getPrice(PENNY).circuitBroken);
        clearing.liquidate(TRADER, PENNY);
        assertEq(clearing.getPosition(TRADER, PENNY).sizeE18, 0);
    }

    function testGapBeyondMarginIsBadDebtAndPausesOnlyNewRisk() public {
        vm.prank(TRADER);
        clearing.depositMargin(PENNY, 201 * USDG);
        _execute(TRADER, int256(200 * E18), 5 * E18, 1);
        // A 40% overnight gap, walked in steps, leaves even a 5x position underwater.
        _publish(4.05e18, 4.05e18);
        _publish(3.3e18, 3.3e18);
        _publish(3e18, 3e18);
        clearing.liquidate(TRADER, PENNY);
        assertGt(clearing.badDebtUsdg(), 0);
        // New risk is refused on this release's clearing house; the large-cap release
        // has its own vault and clearing house and is unaffected.
        vm.prank(TRADER_TWO);
        clearing.depositMargin(PENNY, 100 * USDG);
        FloatClearingHouse.TradeQuote memory quote = _quote(TRADER_TWO, int256(10 * E18), 3e18, 2);
        bytes memory sig = _sign(quote);
        vm.prank(TRADER_TWO);
        vm.expectRevert(FloatClearingHouse.BadDebtOutstanding.selector);
        clearing.execute(quote, sig);
    }

    function _market(uint256 leverage, uint64 maintenanceBps) private pure returns (FloatClearingHouse.Market memory) {
        return FloatClearingHouse.Market({
            state: FloatClearingHouse.MarketState.Active,
            maxLeverageE18: uint64(leverage * E18),
            maintenanceMarginBps: maintenanceBps,
            maxExecutionDeviationBps: 750,
            maxOracleConfidenceBps: 50,
            maxPositionNotionalUsdg: uint128(1_000 * USDG)
        });
    }

    function _publish(uint256 twap, uint256 spot) private {
        FloatOracle.PriceAttestation memory a =
            FloatOracle.PriceAttestation(PENNY, twap, spot, 50, uint64(block.timestamp), ++sequence, uint64(block.timestamp + 60));
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PriceAttestation(bytes32 marketId,uint256 priceE18,uint256 spotPriceE18,uint256 confidenceBps,uint64 timestamp,uint64 sequence,uint64 expiry)"
                ),
                a.marketId, a.priceE18, a.spotPriceE18, a.confidenceBps, a.timestamp, a.sequence, a.expiry
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("FloatSheetsOracle"), keccak256("1"), block.chainid, address(oracle)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        oracle.publish(a, abi.encodePacked(r, s, v));
    }

    function _quote(address trader, int256 size, uint256 price, uint64 nonce)
        private
        view
        returns (FloatClearingHouse.TradeQuote memory)
    {
        uint256 absSize = uint256(size < 0 ? -size : size);
        uint256 notional = (absSize * price + E18 * 1e12 - 1) / (E18 * 1e12);
        return FloatClearingHouse.TradeQuote({
            marketId: PENNY,
            trader: trader,
            sizeDeltaE18: size,
            executionPriceE18: price,
            feeUsdg: (notional * clearing.MIN_TRADE_FEE_BPS() + clearing.BPS() - 1) / clearing.BPS(),
            maxLeverageE18: clearing.getMarket(PENNY).maxLeverageE18,
            oracleSequence: sequence,
            nonce: nonce,
            expiry: uint64(block.timestamp + 60)
        });
    }

    function _sign(FloatClearingHouse.TradeQuote memory quote) private view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "TradeQuote(bytes32 marketId,address trader,int256 sizeDeltaE18,uint256 executionPriceE18,uint256 feeUsdg,uint256 maxLeverageE18,uint64 oracleSequence,uint64 nonce,uint64 expiry)"
                ),
                quote.marketId, quote.trader, quote.sizeDeltaE18, quote.executionPriceE18, quote.feeUsdg,
                quote.maxLeverageE18, quote.oracleSequence, quote.nonce, quote.expiry
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("FloatSheetsClearing"), keccak256("1"), block.chainid, address(clearing)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(QUOTE_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _execute(address trader, int256 size, uint256 price, uint64 nonce) private {
        FloatClearingHouse.TradeQuote memory quote = _quote(trader, size, price, nonce);
        bytes memory sig = _sign(quote);
        vm.prank(trader);
        clearing.execute(quote, sig);
    }
}
