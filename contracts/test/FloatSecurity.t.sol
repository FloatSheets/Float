// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {FloatVault} from "../src/FloatVault.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

contract MockUsdG {
    string public constant name = "Mock USDG";
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blockedRecipient;

    function mint(address receiver, uint256 amount) external {
        balanceOf[receiver] += amount;
    }

    function setBlockedRecipient(address account, bool blocked) external {
        blockedRecipient[account] = blocked;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address receiver, uint256 amount) external returns (bool) {
        _transfer(msg.sender, receiver, amount);
        return true;
    }

    function transferFrom(address sender, address receiver, uint256 amount) external returns (bool) {
        uint256 approved = allowance[sender][msg.sender];
        if (approved != type(uint256).max) allowance[sender][msg.sender] = approved - amount;
        _transfer(sender, receiver, amount);
        return true;
    }

    function _transfer(address sender, address receiver, uint256 amount) private {
        require(!blockedRecipient[receiver], "recipient blocked");
        balanceOf[sender] -= amount;
        balanceOf[receiver] += amount;
    }
}

contract FloatSecurityTest is Test {
    uint256 private constant USDG = 1e6;
    uint256 private constant E18 = 1e18;
    uint256 private constant ORACLE_KEY = 0xA11CE;
    uint256 private constant QUOTE_KEY = 0xB0B;
    bytes32 private constant MARKET_A = keccak256("HIMS-PERP");
    bytes32 private constant MARKET_B = keccak256("NVDA-PERP");
    address private constant TRADER = address(0x1111);
    address private constant TRADER_TWO = address(0x3333);
    address private constant KEEPER = address(0x2222);

    MockUsdG private token;
    FloatOracle private oracle;
    FloatVault private vault;
    FloatClearingHouse private clearing;
    uint256 private lpShares;

    function setUp() public {
        token = new MockUsdG();
        oracle = new FloatOracle(address(this), vm.addr(ORACLE_KEY));
        vault = new FloatVault(address(this), address(token));
        clearing = new FloatClearingHouse(
            address(this), address(token), address(vault), address(oracle), vm.addr(QUOTE_KEY), address(this), 120
        );
        vault.setClearingHouse(address(clearing));
        _configure(MARKET_A, FloatClearingHouse.MarketState.Active);
        _configure(MARKET_B, FloatClearingHouse.MarketState.Active);
        oracle.setMarketEnabled(MARKET_A, true);
        oracle.setMarketEnabled(MARKET_B, true);
        _publish(MARKET_A, 1, 100 * E18, 100 * E18);
        _publish(MARKET_B, 1, 200 * E18, 200 * E18);

        token.mint(address(this), 1_000_000 * USDG);
        token.approve(address(vault), type(uint256).max);
        lpShares = vault.deposit(1_000_000 * USDG, address(this));
        token.mint(TRADER, 100_000 * USDG);
        vm.prank(TRADER);
        token.approve(address(clearing), type(uint256).max);
        token.mint(TRADER_TWO, 100_000 * USDG);
        vm.prank(TRADER_TWO);
        token.approve(address(clearing), type(uint256).max);
    }

    function availableLiquidity() external pure returns (uint256) {
        return type(uint256).max;
    }

    function testFirstDepositorDonationCannotStealVictimDeposit() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(this));
        address attacker = address(0xA7);
        address victim = address(0xB1);
        localToken.mint(attacker, 2_000_001);
        localToken.mint(victim, 100 * USDG);
        vm.startPrank(attacker);
        localToken.approve(address(localVault), type(uint256).max);
        localVault.deposit(1, attacker);
        localToken.transfer(address(localVault), 2_000_000);
        vm.stopPrank();
        vm.startPrank(victim);
        localToken.approve(address(localVault), type(uint256).max);
        uint256 victimShares = localVault.deposit(100 * USDG, victim);
        uint256 recovered = localVault.withdraw(victimShares, victim);
        vm.stopPrank();
        assertGe(recovered, 99 * USDG);
    }

    function testVaultClearingHouseCannotBeReset() public {
        vm.expectRevert(FloatVault.ClearingHouseAlreadySet.selector);
        vault.setClearingHouse(address(this));
    }

    function testVaultRejectsZeroAddressReceiver() public {
        vm.expectRevert(FloatVault.ZeroAddress.selector);
        vault.deposit(USDG, address(0));

        vm.expectRevert(FloatVault.ZeroAddress.selector);
        vault.withdraw(1, address(0));
    }

    function testVaultCanBeRecapitalizedAfterAllRealAssetsAreLost() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(this));
        localToken.mint(address(this), 100 * USDG);
        localToken.approve(address(localVault), type(uint256).max);
        localVault.deposit(100 * USDG, address(this));
        localVault.payout(address(0xdead), 100 * USDG);
        localToken.mint(address(this), 50 * USDG);
        uint256 newShares = localVault.deposit(50 * USDG, address(this));
        assertGt(newShares, 0);
        assertEq(localVault.totalAssets(), 50 * USDG);
    }

    function testStaleEmptyMarketDoesNotFreezeOtherTradingOrLpLiquidity() public {
        vm.warp(block.timestamp + 121);
        _publish(MARKET_A, 2, 100 * E18, 100 * E18);
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 2, 1, 0));
        assertGt(clearing.availableLiquidity(), 0);
    }

    function testStaleExposedMarketUsesLastKnownPriceWithoutGlobalFreeze() public {
        vm.prank(TRADER_TWO);
        clearing.depositMargin(MARKET_B, 20_000 * USDG);
        _execute(_quote(MARKET_B, TRADER_TWO, int256(250 * E18), 200 * E18, 1, 1, 0));
        vm.warp(block.timestamp + 121);
        _publish(MARKET_A, 2, 100 * E18, 100 * E18);
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 2, 1, 0));
        assertGt(clearing.availableLiquidity(), 0);
    }

    function testEmptyMarketCanBeDeregistered() public {
        vm.prank(TRADER_TWO);
        clearing.depositMargin(MARKET_B, 1_000 * USDG);
        clearing.deregisterMarket(MARKET_B);
        assertEq(clearing.marketCount(), 1);
        (FloatClearingHouse.MarketState state,,,,,) = clearing.markets(MARKET_B);
        assertEq(uint8(state), uint8(FloatClearingHouse.MarketState.Unset));
        uint256 before = token.balanceOf(TRADER_TWO);
        vm.prank(TRADER_TWO);
        clearing.withdrawMargin(MARKET_B, 1_000 * USDG);
        assertEq(token.balanceOf(TRADER_TWO), before + 1_000 * USDG);
    }

    function testMarketWithExposureCannotBeDeregistered() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));

        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.deregisterMarket(MARKET_A);
    }

    function testCloseOnlyMarketStillAcceptsSafetyMargin() public {
        _configure(MARKET_A, FloatClearingHouse.MarketState.CloseOnly);
        vm.prank(TRADER);
        clearing.depositMargin(MARKET_A, 1_000 * USDG);
        assertEq(clearing.getPosition(TRADER, MARKET_A).marginUsdg, 1_000 * USDG);
    }

    function testExactBaseDeltaFullyClosesAfterPriceChanges() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 120 * E18, 120 * E18);
        _execute(_quote(MARKET_A, TRADER, -int256(500 * E18), 120 * E18, 2, 2, 0));
        FloatClearingHouse.Position memory position = clearing.getPosition(TRADER, MARKET_A);
        assertEq(position.sizeE18, 0);
        assertEq(position.entryPriceE18, 0);
    }

    function testExactCloseIsNotBlockedWhenLossConsumesFeeBudget() public {
        _depositMargin(10_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 80 * E18, 80 * E18);

        _execute(_quote(MARKET_A, TRADER, -int256(500 * E18), 80 * E18, 2, 2, 24 * USDG));

        FloatClearingHouse.Position memory position = clearing.getPosition(TRADER, MARKET_A);
        assertEq(position.sizeE18, 0);
        assertEq(position.marginUsdg, 0);
        assertEq(position.entryPriceE18, 0);
    }

    function testPartialCloseWorksBelowInitialMarginAndAboveExposureCap() public {
        _depositMargin(10_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 94 * E18, 94 * E18);
        _execute(_quote(MARKET_A, TRADER, -int256(250 * E18), 94 * E18, 2, 2, 0));
        FloatClearingHouse.Position memory position = clearing.getPosition(TRADER, MARKET_A);
        assertEq(position.sizeE18, int256(250 * E18));
    }

    function testVaultWithdrawalPreservesFiftyPercentUtilizationLimit() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        assertApproxEqAbs(clearing.availableLiquidity(), 900_000 * USDG, 2);
        vm.expectRevert(FloatVault.InsufficientAvailableLiquidity.selector);
        vault.withdraw(lpShares * 91 / 100, address(this));
    }

    function testRejectsMaintenanceMarginAtOrAboveInitialMargin() public {
        FloatClearingHouse.Market memory invalidMarket = FloatClearingHouse.Market({
            state: FloatClearingHouse.MarketState.Active,
            maxLeverageE18: uint64(10 * E18),
            maintenanceMarginBps: 1_000,
            maxExecutionDeviationBps: 100,
            maxOracleConfidenceBps: 50,
            maxPositionNotionalUsdg: uint128(100_000 * USDG)
        });
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(keccak256("BAD"), invalidMarket);
    }

    function testSpotTwapCircuitBreakerBlocksIncreaseAndAllowsReduction() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 100 * E18, 102 * E18);
        FloatClearingHouse.TradeQuote memory increase = _quote(MARKET_A, TRADER, int256(10 * E18), 100 * E18, 2, 2, 0);
        vm.expectRevert(FloatClearingHouse.MarketNotActive.selector);
        vm.prank(TRADER);
        clearing.execute(increase, _signQuote(increase));
        _execute(_quote(MARKET_A, TRADER, -int256(250 * E18), 100 * E18, 2, 3, 0));
    }

    function testBlacklistedTraderCannotBlockLiquidation() public {
        _depositMargin(10_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 82 * E18, 82 * E18);
        token.setBlockedRecipient(TRADER, true);
        vm.prank(KEEPER);
        clearing.liquidate(TRADER, MARKET_A);
        assertEq(clearing.getPosition(TRADER, MARKET_A).sizeE18, 0);
        assertGt(clearing.claimableBalance(TRADER), 0);
        assertGt(clearing.claimableBalance(KEEPER), 0);

        uint256 traderClaim = clearing.claimableBalance(TRADER);
        uint256 receiverBefore = token.balanceOf(TRADER_TWO);
        vm.prank(TRADER);
        clearing.claim(TRADER_TWO);
        assertEq(token.balanceOf(TRADER_TWO), receiverBefore + traderClaim);
        assertEq(clearing.claimableBalance(TRADER), 0);
    }

    function testBankruptLiquidationStillCreditsKeeperReward() public {
        _depositMargin(10_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 70 * E18, 70 * E18);
        vm.prank(KEEPER);
        clearing.liquidate(TRADER, MARKET_A);
        assertGt(clearing.claimableBalance(KEEPER), 0);
    }

    function testFeeCapAndTraderQuoteCancellation() public {
        _depositMargin(20_000 * USDG);
        FloatClearingHouse.TradeQuote memory expensive =
            _quote(MARKET_A, TRADER, int256(100 * E18), 100 * E18, 1, 1, 2_000 * USDG);
        vm.expectRevert(FloatClearingHouse.FeeTooHigh.selector);
        vm.prank(TRADER);
        clearing.execute(expensive, _signQuote(expensive));

        vm.prank(TRADER);
        clearing.cancelQuote(2);
        FloatClearingHouse.TradeQuote memory cancelled = _quote(MARKET_A, TRADER, int256(10 * E18), 100 * E18, 1, 2, 0);
        vm.expectRevert(FloatClearingHouse.QuoteUsed.selector);
        vm.prank(TRADER);
        clearing.execute(cancelled, _signQuote(cancelled));

        vm.prank(TRADER);
        clearing.cancelQuotesBefore(10);
        FloatClearingHouse.TradeQuote memory oldNonce = _quote(MARKET_A, TRADER, int256(10 * E18), 100 * E18, 1, 9, 0);
        vm.expectRevert(FloatClearingHouse.QuoteUsed.selector);
        vm.prank(TRADER);
        clearing.execute(oldNonce, _signQuote(oldNonce));
    }

    function _configure(bytes32 marketId, FloatClearingHouse.MarketState state) private {
        clearing.setMarket(
            marketId,
            FloatClearingHouse.Market({
                state: state,
                maxLeverageE18: uint64(5 * E18),
                maintenanceMarginBps: 1_000,
                maxExecutionDeviationBps: 100,
                maxOracleConfidenceBps: 50,
                maxPositionNotionalUsdg: uint128(150_000 * USDG)
            })
        );
    }

    function _depositMargin(uint256 amount) private {
        vm.prank(TRADER);
        clearing.depositMargin(MARKET_A, amount);
    }

    function _execute(FloatClearingHouse.TradeQuote memory quote) private {
        bytes memory signature = _signQuote(quote);
        vm.prank(quote.trader);
        clearing.execute(quote, signature);
    }

    function _quote(
        bytes32 marketId,
        address trader,
        int256 sizeDelta,
        uint256 price,
        uint64 oracleSequence,
        uint64 nonce,
        uint256 fee
    ) private view returns (FloatClearingHouse.TradeQuote memory) {
        return FloatClearingHouse.TradeQuote({
            marketId: marketId,
            trader: trader,
            sizeDeltaE18: sizeDelta,
            executionPriceE18: price,
            feeUsdg: fee,
            maxLeverageE18: 5 * E18,
            oracleSequence: oracleSequence,
            nonce: nonce,
            expiry: uint64(block.timestamp + 60)
        });
    }

    function _publish(bytes32 marketId, uint64 sequence, uint256 twap, uint256 spot) private {
        FloatOracle.PriceAttestation memory attestation = FloatOracle.PriceAttestation({
            marketId: marketId,
            priceE18: twap,
            spotPriceE18: spot,
            confidenceBps: 10,
            timestamp: uint64(block.timestamp),
            sequence: sequence,
            expiry: uint64(block.timestamp + 60)
        });
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
                attestation.marketId,
                attestation.priceE18,
                attestation.spotPriceE18,
                attestation.confidenceBps,
                attestation.timestamp,
                attestation.sequence,
                attestation.expiry
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ORACLE_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        oracle.publish(attestation, abi.encodePacked(r, s, v));
    }

    function _signQuote(FloatClearingHouse.TradeQuote memory quote) private view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("FloatSheetsClearing"),
                keccak256("1"),
                block.chainid,
                address(clearing)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "TradeQuote(bytes32 marketId,address trader,int256 sizeDeltaE18,uint256 executionPriceE18,uint256 feeUsdg,uint256 maxLeverageE18,uint64 oracleSequence,uint64 nonce,uint64 expiry)"
                ),
                quote.marketId,
                quote.trader,
                quote.sizeDeltaE18,
                quote.executionPriceE18,
                quote.feeUsdg,
                quote.maxLeverageE18,
                quote.oracleSequence,
                quote.nonce,
                quote.expiry
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(QUOTE_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
