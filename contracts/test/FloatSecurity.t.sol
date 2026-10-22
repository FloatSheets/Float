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

contract MockLiquidityView {
    int256 public pnl;
    uint256 public margin;
    uint256 public liquidity = type(uint256).max;

    function set(int256 pnl_, uint256 margin_) external {
        pnl = pnl_;
        margin = margin_;
    }

    function setLiquidity(uint256 liquidity_) external {
        liquidity = liquidity_;
    }

    function navPricesFresh() external pure returns (bool) {
        return true;
    }

    function availableLiquidity() external view returns (uint256) {
        return liquidity;
    }

    function activePositionCount() external pure returns (uint256) {
        return 0;
    }

    function unrealizedPnlUsdg() external view returns (int256) {
        return pnl;
    }

    function totalOpenPositionMarginUsdg() external view returns (uint256) {
        return margin;
    }

    function payout(FloatVault vault, address receiver, uint256 amount) external returns (uint256) {
        return vault.payout(receiver, amount);
    }
}

contract FloatSecurityTest is Test {
    uint256 private constant USDG = 1e6;
    uint256 private constant E18 = 1e18;
    uint256 private constant ORACLE_KEY = 0xA11CE;
    uint256 private constant QUOTE_KEY = 0xB0B;
    bytes32 private constant MARKET_A = keccak256("HIMS-PERP");
    bytes32 private constant MARKET_B = keccak256("NVDA-PERP");
    bytes32 private constant MARKET_C = keccak256("PLTR-PERP");
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
        vm.warp(block.timestamp + clearing.CONFIG_DELAY());
        clearing.applyMarket(MARKET_A);
        clearing.applyMarket(MARKET_B);
        oracle.applyMarketEnabled(MARKET_A);
        oracle.applyMarketEnabled(MARKET_B);
        token.mint(address(this), 1_000_000 * USDG);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000 * USDG, address(this));
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        vault.settleQueue();
        lpShares = vault.claimDeposit(vault.queueEpoch());
        vault.startNextQueueEpoch();
        _publish(MARKET_A, 1, 100 * E18, 100 * E18);
        _publish(MARKET_B, 1, 200 * E18, 200 * E18);
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

    function activePositionCount() external pure returns (uint256) {
        return 0;
    }

    function unrealizedPnlUsdg() external pure returns (int256) {
        return 0;
    }

    function navPricesFresh() external pure returns (bool) {
        return true;
    }

    function _settleVaultQueue() private {
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        FloatOracle.Price memory marketA = oracle.getPrice(MARKET_A);
        FloatOracle.Price memory marketB = oracle.getPrice(MARKET_B);
        _publish(MARKET_A, marketA.sequence + 1, marketA.priceE18, marketA.priceE18);
        _publish(MARKET_B, marketB.sequence + 1, marketB.priceE18, marketB.priceE18);
        vault.settleQueue();
        if (vault.queuedDepositOf(vault.queueEpoch(), address(this)) != 0) vault.claimDeposit(vault.queueEpoch());
        if (vault.queuedWithdrawalOf(vault.queueEpoch(), address(this)) != 0) {
            vault.claimWithdrawal(vault.queueEpoch(), address(this));
        }
        vault.startNextQueueEpoch();
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
        localVault.deposit(100 * USDG, victim);
        vm.stopPrank();
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        uint64 localEpoch = localVault.queueEpoch();
        vm.prank(attacker);
        localVault.claimDeposit(localEpoch);
        vm.prank(victim);
        uint256 victimShares = localVault.claimDeposit(localEpoch);
        localVault.startNextQueueEpoch();
        vm.prank(victim);
        localVault.withdraw(victimShares, victim);
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        localEpoch = localVault.queueEpoch();
        vm.prank(victim);
        uint256 recovered = localVault.claimWithdrawal(localEpoch, victim);
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
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        localVault.claimDeposit(localVault.queueEpoch());
        localVault.startNextQueueEpoch();
        localVault.payout(address(0xdead), 100 * USDG);
        localToken.mint(address(this), 50 * USDG);
        localVault.deposit(50 * USDG, address(this));
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        assertGt(localVault.claimDeposit(localVault.queueEpoch()), 0);
        assertEq(localVault.totalAssets(), 50 * USDG);
    }

    function testVaultBlocksDepositsUntilClearingHouseIsLinked() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localToken.mint(address(this), USDG);
        localToken.approve(address(localVault), type(uint256).max);
        vm.expectRevert(FloatVault.ClearingHouseNotSet.selector);
        localVault.deposit(USDG, address(this));
    }

    function testVaultAssetsAndZeroShareDepositEdges() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault unlinked = new FloatVault(address(this), address(localToken));
        localToken.mint(address(unlinked), 10 * USDG);
        assertEq(unlinked.totalAssets(), 10 * USDG);

        FloatVault linked = new FloatVault(address(this), address(localToken));
        MockLiquidityView viewMock = new MockLiquidityView();
        linked.setClearingHouse(address(viewMock));
        localToken.mint(address(linked), 10 * USDG);
        viewMock.set(int256(10 * USDG), 0);
        assertEq(linked.totalAssets(), 0);

        FloatVault donated = new FloatVault(address(this), address(localToken));
        donated.setClearingHouse(address(this));
        localToken.mint(address(donated), 1e12);
        localToken.mint(address(this), 1);
        localToken.approve(address(donated), type(uint256).max);
        vm.expectRevert(FloatVault.ZeroAmount.selector);
        donated.deposit(1, address(this));
    }

    function testNewMarketMustBeRegisteredPausedAndZeroOwnerRejected() public {
        FloatClearingHouse.Market memory active = clearing.getMarket(MARKET_A);
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(keccak256("NEW"), active);
        vm.expectRevert(FloatClearingHouse.ZeroAddress.selector);
        clearing.scheduleOwnershipTransfer(address(0));
    }

    function testInitialActiveMarketCanBeRegisteredForLaunch() public {
        FloatClearingHouse.Market memory launchMarket = clearing.getMarket(MARKET_A);
        clearing.registerMarket(MARKET_C, launchMarket);
        assertEq(uint256(clearing.getMarket(MARKET_C).state), uint256(FloatClearingHouse.MarketState.Active));
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.registerMarket(MARKET_C, launchMarket);
    }

    function testMismatchedVaultAssetIsRejected() public {
        MockUsdG otherToken = new MockUsdG();
        FloatVault otherVault = new FloatVault(address(this), address(otherToken));
        vm.expectRevert(FloatClearingHouse.ZeroAddress.selector);
        new FloatClearingHouse(
            address(this), address(token), address(otherVault), address(oracle), vm.addr(QUOTE_KEY), address(this), 120
        );
    }

    function testNetExposureReserveAndShortLossMark() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(100 * E18), 100 * E18, 1, 1, 0));
        assertLt(clearing.availableLiquidity(), vault.totalAssets());

        vm.prank(TRADER_TWO);
        clearing.depositMargin(MARKET_B, 20_000 * USDG);
        _execute(_quote(MARKET_B, TRADER_TWO, -int256(100 * E18), 200 * E18, 1, 1, 0));
        _publish(MARKET_B, 2, 210 * E18, 210 * E18);
        assertLt(clearing.unrealizedPnlUsdg(), 0);
    }

    function testMarginWithdrawalWithNoDeferredPayout() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(E18), 100 * E18, 1, 1, 0));
        vm.prank(TRADER);
        clearing.withdrawMargin(MARKET_A, USDG);
    }

    function testReversalAndHealthyPositionCannotBeLiquidated() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(E18), 100 * E18, 1, 1, 0));
        _execute(_quote(MARKET_A, TRADER, -int256(2 * E18), 100 * E18, 1, 2, 0));
        vm.expectRevert(FloatClearingHouse.PositionNotLiquidatable.selector);
        clearing.liquidate(TRADER, MARKET_A);
    }

    function testMultipleQueuedWithdrawalClaimsUseProportionalRemainder() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(this));
        address second = address(0xBEEF);
        localToken.mint(address(this), 20 * USDG);
        localToken.mint(second, 30 * USDG);
        localToken.approve(address(localVault), type(uint256).max);
        vm.prank(second);
        localToken.approve(address(localVault), type(uint256).max);
        localVault.deposit(20 * USDG, address(this));
        vm.prank(second);
        localVault.deposit(30 * USDG, second);
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        uint64 epoch = localVault.queueEpoch();
        localVault.claimDeposit(epoch);
        vm.prank(second);
        localVault.claimDeposit(epoch);
        localVault.startNextQueueEpoch();
        localVault.withdraw(localVault.balanceOf(address(this)), address(this));
        uint256 secondShares = localVault.balanceOf(second);
        vm.prank(second);
        localVault.withdraw(secondShares, second);
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        epoch = localVault.queueEpoch();
        localVault.claimWithdrawal(epoch, address(this));
        vm.prank(second);
        localVault.claimWithdrawal(epoch, second);
    }

    function testStaleEmptyMarketDoesNotFreezeOtherTradingOrLpLiquidity() public {
        vm.warp(block.timestamp + 121);
        _publish(MARKET_A, 2, 100 * E18, 100 * E18);
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 2, 1, 0));
        assertGt(clearing.availableLiquidity(), 0);
    }

    function testStaleExposureMarksSharedVaultNavUnsafe() public {
        vm.prank(TRADER_TWO);
        clearing.depositMargin(MARKET_B, 20_000 * USDG);
        _execute(_quote(MARKET_B, TRADER_TWO, int256(250 * E18), 200 * E18, 1, 1, 0));
        vm.warp(block.timestamp + 121);
        _publish(MARKET_A, 2, 100 * E18, 100 * E18);
        assertFalse(clearing.navPricesFresh());
        assertEq(vault.totalAssets(), 0);
        assertEq(clearing.availableLiquidity(), 0);
    }

    function testStaleExposedMarkIsExcludedFromVaultNavAndQueueSettlement() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        vm.warp(block.timestamp + 121);
        assertFalse(clearing.navPricesFresh());
        assertEq(vault.totalAssets(), 0);
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        vm.expectRevert(FloatVault.StaleNav.selector);
        vault.settleQueue();
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
        _depositMargin(10_030 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 80 * E18, 80 * E18);

        _execute(_quote(MARKET_A, TRADER, -int256(500 * E18), 80 * E18, 2, 2, 24 * USDG));

        FloatClearingHouse.Position memory position = clearing.getPosition(TRADER, MARKET_A);
        assertEq(position.sizeE18, 0);
        assertEq(position.marginUsdg, 0);
        assertEq(position.entryPriceE18, 0);
    }

    function testPartialCloseWorksBelowInitialMarginAndAboveExposureCap() public {
        _depositMargin(10_030 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 94 * E18, 94 * E18);
        _execute(_quote(MARKET_A, TRADER, -int256(250 * E18), 94 * E18, 2, 2, 0));
        FloatClearingHouse.Position memory position = clearing.getPosition(TRADER, MARKET_A);
        assertEq(position.sizeE18, int256(250 * E18));
    }

    function testVaultWithdrawalPreservesFiftyPercentUtilizationLimit() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        assertApproxEqAbs(clearing.availableLiquidity(), 987_500 * USDG, 2);
        vault.withdraw(lpShares * 91 / 100, address(this));
        _settleVaultQueue();
        assertGt(token.balanceOf(address(this)), 0);
    }

    function testVaultNavReflectsUnrealizedTraderPnl() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 110 * E18, 110 * E18);
        assertEq(vault.totalAssets(), 995_000 * USDG);
        _publish(MARKET_A, 3, 90 * E18, 90 * E18);
        assertEq(vault.totalAssets(), 1_005_000 * USDG);
    }

    function testUnrealizedLossRecognitionIsCappedByOpenTraderMargin() public {
        _depositMargin(20_030 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        vm.prank(TRADER);
        clearing.withdrawMargin(MARKET_A, 10_000 * USDG);
        _publish(MARKET_A, 2, 85 * E18, 85 * E18);
        _publish(MARKET_A, 3, 70 * E18, 70 * E18);
        assertEq(vault.totalAssets(), 1_010_000 * USDG);
    }

    function testCrowdedSideBorrowFeeAccruesToInsurance() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        vm.warp(block.timestamp + 1 hours);
        _publish(MARKET_A, 2, 100 * E18, 100 * E18);
        _execute(_quote(MARKET_A, TRADER, -int256(500 * E18), 100 * E18, 2, 2, 0));
        assertEq(vault.insuranceAssets(), 50 * USDG);
    }

    function testInsuranceIsUsedBeforeRecordingSeniorPayoutClaim() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(this));
        localToken.mint(address(this), 20 * USDG);
        localToken.approve(address(localVault), type(uint256).max);
        localVault.fundInsurance(20 * USDG);
        assertEq(localVault.payout(address(0xCAFE), 50 * USDG), 1 * USDG);
        assertEq(localVault.insuranceAssets(), 19 * USDG);
        assertEq(localVault.totalPayoutOwed(), 49 * USDG);
    }

    function testInsuranceAbsorbsTraderPayoutBeforeLpAssets() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(this));
        localToken.mint(address(this), 120 * USDG);
        localToken.approve(address(localVault), type(uint256).max);
        localVault.deposit(100 * USDG, address(this));
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        localVault.claimDeposit(localVault.queueEpoch());
        localVault.startNextQueueEpoch();
        localVault.fundInsurance(20 * USDG);
        assertEq(localVault.payout(address(0xCAFE), 50 * USDG), 6 * USDG);
        assertEq(localVault.insuranceAssets(), 14 * USDG);
        assertEq(localVault.totalAssets(), 56 * USDG);
    }

    function testUnclaimedEpochDoesNotBlockTheNextQueueEpoch() public {
        token.mint(address(this), USDG);
        vault.deposit(USDG, address(this));
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        vault.settleQueue();
        vault.startNextQueueEpoch();
        token.mint(address(this), USDG);
        vault.deposit(USDG, address(this));
        assertEq(vault.queueEpoch(), 2);
    }

    function testLpEntryAndExitCanBeQueuedWhileTraderPositionIsOpen() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        assertEq(clearing.activePositionCount(), 1);
        token.mint(address(this), USDG);
        vault.deposit(USDG, address(this));
        vault.withdraw(1, address(this));

        _publish(MARKET_A, 2, 100 * E18, 100 * E18);
        _execute(_quote(MARKET_A, TRADER, -int256(500 * E18), 100 * E18, 2, 2, 0));
        assertEq(clearing.activePositionCount(), 0);
        token.mint(address(this), USDG);
        vault.deposit(USDG, address(this));
        _settleVaultQueue();
        assertGt(vault.balanceOf(address(this)), lpShares);
    }

    function testExpiredPositionCanBePermissionlesslySettled() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        vm.warp(block.timestamp + clearing.MAX_POSITION_DURATION());
        _publish(MARKET_A, 2, 100 * E18, 100 * E18);
        vm.prank(KEEPER);
        clearing.liquidate(TRADER, MARKET_A);
        assertEq(clearing.activePositionCount(), 0);
        assertEq(clearing.getPosition(TRADER, MARKET_A).sizeE18, 0);
        assertGt(clearing.claimableBalance(TRADER), 0);
        vm.prank(TRADER);
        clearing.claim(TRADER);
        assertEq(clearing.claimableBalance(TRADER), 0);
    }

    function testQueueClaimsRejectUnsettledEmptyAndDuplicateClaims() public {
        vm.startPrank(TRADER);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(USDG, TRADER);
        vm.stopPrank();
        uint64 depositEpoch = vault.queueEpoch();
        vm.expectRevert(FloatVault.QueueNotReady.selector);
        vm.prank(TRADER);
        vault.claimDeposit(depositEpoch);
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        vault.settleQueue();
        depositEpoch = vault.queueEpoch();
        vm.expectRevert(FloatVault.NothingQueued.selector);
        vm.prank(TRADER_TWO);
        vault.claimDeposit(depositEpoch);
        vm.prank(TRADER);
        uint256 shares = vault.claimDeposit(depositEpoch);
        vm.expectRevert(FloatVault.NothingQueued.selector);
        vm.prank(TRADER);
        vault.claimDeposit(depositEpoch);
        vault.startNextQueueEpoch();

        vm.prank(TRADER);
        vault.withdraw(shares, TRADER);
        uint64 withdrawalEpoch = vault.queueEpoch();
        vm.expectRevert(FloatVault.ZeroAddress.selector);
        vault.claimWithdrawal(withdrawalEpoch, address(0));
        vm.expectRevert(FloatVault.QueueNotReady.selector);
        vm.prank(TRADER);
        vault.claimWithdrawal(withdrawalEpoch, TRADER);
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        vault.settleQueue();
        vm.expectRevert(FloatVault.NothingQueued.selector);
        vm.prank(TRADER_TWO);
        vault.claimWithdrawal(withdrawalEpoch, TRADER_TWO);
        vm.prank(TRADER);
        vault.claimWithdrawal(withdrawalEpoch, TRADER);
        vm.expectRevert(FloatVault.NothingQueued.selector);
        vm.prank(TRADER);
        vault.claimWithdrawal(withdrawalEpoch, TRADER);
    }

    function testBadDebtPausesNewRiskUntilSomeoneRecapitalizesVault() public {
        _depositMargin(10_030 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 85 * E18, 85 * E18);
        _publish(MARKET_A, 3, 70 * E18, 70 * E18);
        vm.prank(KEEPER);
        clearing.liquidate(TRADER, MARKET_A);
        assertEq(clearing.badDebtUsdg(), 5_000 * USDG);

        vm.prank(TRADER_TWO);
        clearing.depositMargin(MARKET_A, 20_000 * USDG);
        FloatClearingHouse.TradeQuote memory blocked = _quote(MARKET_A, TRADER_TWO, int256(10 * E18), 70 * E18, 3, 1, 0);
        vm.expectRevert(FloatClearingHouse.BadDebtOutstanding.selector);
        _execute(blocked);

        token.mint(address(this), 5_000 * USDG);
        token.approve(address(clearing), type(uint256).max);
        clearing.coverBadDebt(5_000 * USDG);
        assertEq(clearing.badDebtUsdg(), 0);
        _execute(blocked);
        assertEq(clearing.getPosition(TRADER_TWO, MARKET_A).sizeE18, int256(10 * E18));
    }

    function testVaultDefersUnderfundedPayoutAndPaysItAfterRecapitalization() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(this));
        uint256 payout = 10 * USDG;
        assertEq(localVault.payout(address(this), payout), 0);
        assertEq(localVault.totalPayoutOwed(), payout);
        assertEq(localVault.totalAssets(), 0);
        localToken.mint(address(localVault), 21 * payout);
        assertEq(localVault.claimPayout(address(0xCAFE), payout), payout);
        assertEq(localVault.payoutOwed(address(this)), 0);
        assertEq(localToken.balanceOf(address(0xCAFE)), payout);
    }

    function testVaultDepositClaimsConserveAggregateSharesAcrossRounding() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(this));
        localToken.mint(address(this), 7_000_000);
        localToken.approve(address(localVault), type(uint256).max);
        localVault.deposit(7_000_000, address(this));
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        localVault.claimDeposit(localVault.queueEpoch());
        localVault.startNextQueueEpoch();

        address alice = address(0xA11);
        address bob = address(0xB0B);
        address carol = address(0xCA1);
        address[3] memory users = [alice, bob, carol];
        uint256[3] memory amounts = [uint256(1), uint256(2), uint256(4)];
        for (uint256 i; i < users.length; ++i) {
            localToken.mint(users[i], amounts[i]);
            vm.startPrank(users[i]);
            localToken.approve(address(localVault), type(uint256).max);
            localVault.deposit(amounts[i], users[i]);
            vm.stopPrank();
        }
        uint64 epoch = localVault.queueEpoch();
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        uint256 totalClaimed;
        for (uint256 i; i < users.length; ++i) {
            vm.prank(users[i]);
            totalClaimed += localVault.claimDeposit(epoch);
        }
        assertEq(totalClaimed, localVault.settledDepositShares());
        assertEq(localVault.settledDepositSharesRemaining(epoch), 0);
    }

    function testHourlyPayoutCapDefersExcessWithoutBlockingSettlement() public {
        MockUsdG localToken = new MockUsdG();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(this));
        localToken.mint(address(localVault), 1_000);
        assertEq(localVault.payout(address(this), 100), 50);
        assertEq(localVault.totalPayoutOwed(), 50);
        assertEq(localVault.payout(address(this), 100), 0);
        assertEq(localVault.totalPayoutOwed(), 150);
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
        vm.expectRevert(FloatClearingHouse.StaleOraclePrice.selector);
        vm.prank(KEEPER);
        clearing.liquidate(TRADER, MARKET_A);
        _execute(_quote(MARKET_A, TRADER, -int256(250 * E18), 100 * E18, 2, 3, 0));
    }

    function testLargeOracleJumpDoesNotRefreshFrozenPriceTimestamp() public {
        uint64 previousTimestamp = oracle.getPrice(MARKET_A).timestamp;
        vm.warp(block.timestamp + 30);
        _publish(MARKET_A, 2, 125 * E18, 125 * E18);
        FloatOracle.Price memory price = oracle.getPrice(MARKET_A);
        assertEq(price.priceE18, 100 * E18);
        assertEq(price.timestamp, previousTimestamp);
        assertEq(price.sequence, 2);
        assertTrue(price.circuitBroken);
    }

    function testPendingDepositAssetsAreReservedFromTraderPayouts() public {
        MockUsdG localToken = new MockUsdG();
        MockLiquidityView liquidity = new MockLiquidityView();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(liquidity));
        localToken.mint(address(this), 250 * USDG);
        localToken.approve(address(localVault), type(uint256).max);
        localVault.deposit(100 * USDG, address(this));
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        localVault.claimDeposit(localVault.queueEpoch());
        localVault.startNextQueueEpoch();
        localVault.deposit(150 * USDG, address(this));
        liquidity.set(-int256(2_000 * USDG), 2_000 * USDG);
        uint256 paid = liquidity.payout(localVault, address(0xCAFE), 100 * USDG);
        assertEq(paid, 100 * USDG);
        assertEq(localToken.balanceOf(address(localVault)), localVault.pendingDepositAssets());
    }

    function testUnderfundedWithdrawalBatchDoesNotBlockQueueAndCanBeCancelled() public {
        MockUsdG localToken = new MockUsdG();
        MockLiquidityView liquidity = new MockLiquidityView();
        FloatVault localVault = new FloatVault(address(this), address(localToken));
        localVault.setClearingHouse(address(liquidity));
        localToken.mint(address(this), 200 * USDG);
        localToken.approve(address(localVault), type(uint256).max);
        localVault.deposit(100 * USDG, address(this));
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        uint256 shares = localVault.claimDeposit(localVault.queueEpoch());
        localVault.startNextQueueEpoch();
        localVault.withdraw(shares, address(this));
        localVault.deposit(100 * USDG, address(this));
        liquidity.setLiquidity(0);
        vm.warp(block.timestamp + localVault.QUEUE_EPOCH_DURATION());
        localVault.settleQueue();
        uint64 settledEpoch = localVault.queueEpoch();
        assertEq(localVault.settledWithdrawalShares(), 0);
        assertGt(localVault.claimDeposit(settledEpoch), 0);
        assertEq(localVault.cancelQueuedWithdrawal(settledEpoch), shares);
        localVault.startNextQueueEpoch();
        localToken.mint(address(this), 1 * USDG);
        localVault.deposit(1 * USDG, address(this));
    }

    function testBlacklistedTraderCannotBlockLiquidation() public {
        _depositMargin(10_030 * USDG);
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
        _depositMargin(10_030 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(500 * E18), 100 * E18, 1, 1, 0));
        _publish(MARKET_A, 2, 85 * E18, 85 * E18);
        _publish(MARKET_A, 3, 70 * E18, 70 * E18);
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
        FloatClearingHouse.Market memory market = FloatClearingHouse.Market({
            state: FloatClearingHouse.MarketState.Paused,
            maxLeverageE18: uint64(5 * E18),
            maintenanceMarginBps: 1_000,
            maxExecutionDeviationBps: 100,
            maxOracleConfidenceBps: 50,
            maxPositionNotionalUsdg: uint128(150_000 * USDG)
        });
        clearing.setMarket(marketId, market);
        market.state = state;
        clearing.setMarket(marketId, market);
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
        if (fee == 0) {
            uint256 notional = uint256(sizeDelta < 0 ? -sizeDelta : sizeDelta) * price / (E18 * 1e12);
            if (uint256(sizeDelta < 0 ? -sizeDelta : sizeDelta) * price % (E18 * 1e12) != 0) ++notional;
            fee = (notional * clearing.MIN_TRADE_FEE_BPS() + clearing.BPS() - 1) / clearing.BPS();
        }
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

    function testZeroFeeQuoteCannotOpenForFree() public {
        _depositMargin(20_000 * USDG);
        FloatClearingHouse.TradeQuote memory freeQuote = _quote(MARKET_A, TRADER, int256(10 * E18), 100 * E18, 1, 1, 0);
        freeQuote.feeUsdg = 0;
        vm.expectRevert(FloatClearingHouse.FeeTooHigh.selector);
        vm.prank(TRADER);
        clearing.execute(freeQuote, _signQuote(freeQuote));
    }

    function testRiskIncreasingMarketChangeAppliesImmediatelyAndPauseIsImmediate() public {
        FloatClearingHouse.Market memory changed = FloatClearingHouse.Market({
            state: FloatClearingHouse.MarketState.Active,
            maxLeverageE18: uint64(10 * E18),
            maintenanceMarginBps: 500,
            maxExecutionDeviationBps: 100,
            maxOracleConfidenceBps: 50,
            maxPositionNotionalUsdg: uint128(150_000 * USDG)
        });
        clearing.setMarket(MARKET_A, changed);
        assertEq(clearing.getMarket(MARKET_A).maxLeverageE18, 5 * E18);
        clearing.applyMarket(MARKET_A);
        assertEq(clearing.getMarket(MARKET_A).maxLeverageE18, 10 * E18);
        changed.state = FloatClearingHouse.MarketState.Paused;
        clearing.setMarket(MARKET_A, changed);
        assertEq(uint256(clearing.getMarket(MARKET_A).state), uint256(FloatClearingHouse.MarketState.Paused));
    }

    function testBorrowFeeFractionalAccrualIsCarriedForward() public {
        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(1 * E18), 100 * E18, 1, 1, 0));
        vm.warp(block.timestamp + 1);
        _execute(_quote(MARKET_A, TRADER, -int256(1), 100 * E18, 1, 2, 0));
        assertGt(clearing.borrowFeeRemainder(TRADER, MARKET_A), 0);
    }

    function testBalancedLongAndShortExposureDoesNotAccrueSkewBorrowFee() public {
        _depositMargin(20_000 * USDG);
        vm.prank(TRADER_TWO);
        clearing.depositMargin(MARKET_A, 20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(E18), 100 * E18, 1, 1, 0));
        _execute(_quote(MARKET_A, TRADER_TWO, -int256(E18), 100 * E18, 1, 1, 0));
        vm.warp(block.timestamp + 1 hours);
        _publish(MARKET_A, 2, 100 * E18, 100 * E18);
        _execute(_quote(MARKET_A, TRADER, int256(E18), 100 * E18, 2, 2, 0));
        assertEq(clearing.borrowFeeRemainder(TRADER, MARKET_A), 0);
    }

    function testQuoteCannotUsePriceOutsideProtocolHardBound() public {
        _depositMargin(20_000 * USDG);
        FloatClearingHouse.TradeQuote memory quote = _quote(MARKET_A, TRADER, int256(10 * E18), 108 * E18, 1, 1, 0);
        vm.expectRevert(FloatClearingHouse.ExecutionPriceOutOfBounds.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _signQuote(quote));
    }

    function testFuzz_MarketDeviationCannotExceedHardBound(uint16 deviation) public {
        deviation = uint16(deviation % 10_001);
        FloatClearingHouse.Market memory market = clearing.getMarket(MARKET_A);
        market.maxExecutionDeviationBps = deviation;
        if (deviation > clearing.MAX_QUOTE_ORACLE_DEVIATION_BPS()) {
            vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
            clearing.setMarket(MARKET_A, market);
        } else {
            clearing.setMarket(MARKET_A, market);
            assertLe(clearing.getMarket(MARKET_A).maxExecutionDeviationBps, clearing.MAX_QUOTE_ORACLE_DEVIATION_BPS());
        }
    }

    function testOwnerAndClearingHouseOnlyEntrypointsRejectStrangers() public {
        FloatClearingHouse.Market memory market = clearing.getMarket(MARKET_A);
        vm.expectRevert(FloatClearingHouse.Unauthorized.selector);
        vm.prank(KEEPER);
        clearing.setMarket(MARKET_A, market);
        vm.expectRevert(FloatClearingHouse.Unauthorized.selector);
        vm.prank(KEEPER);
        clearing.deregisterMarket(MARKET_A);
        vm.expectRevert(FloatClearingHouse.Unauthorized.selector);
        vm.prank(KEEPER);
        clearing.scheduleOwnershipTransfer(TRADER);
        vm.expectRevert(FloatClearingHouse.Unauthorized.selector);
        vm.prank(KEEPER);
        clearing.setQuoteSigner(TRADER);
        vm.expectRevert(FloatClearingHouse.Unauthorized.selector);
        vm.prank(KEEPER);
        clearing.setFeeRecipient(TRADER);
        vm.expectRevert(FloatClearingHouse.Unauthorized.selector);
        vm.prank(KEEPER);
        clearing.setOracleMaxAgeSeconds(60);

        vm.expectRevert(FloatOracle.Unauthorized.selector);
        vm.prank(KEEPER);
        oracle.setSigner(TRADER);
        vm.expectRevert(FloatOracle.Unauthorized.selector);
        vm.prank(KEEPER);
        oracle.scheduleOwnershipTransfer(TRADER);
        vm.expectRevert(FloatOracle.Unauthorized.selector);
        vm.prank(KEEPER);
        oracle.setMarketEnabled(MARKET_A, false);

        vm.expectRevert(FloatVault.Unauthorized.selector);
        vm.prank(KEEPER);
        vault.setClearingHouse(TRADER);
        vm.expectRevert(FloatVault.Unauthorized.selector);
        vm.prank(KEEPER);
        vault.scheduleOwnershipTransfer(TRADER);
        vm.expectRevert(FloatVault.Unauthorized.selector);
        vm.prank(KEEPER);
        vault.fundInsuranceFromClearingHouse(USDG);
        vm.expectRevert(FloatVault.Unauthorized.selector);
        vm.prank(KEEPER);
        vault.payout(TRADER, USDG);
        vm.expectRevert(FloatVault.Unauthorized.selector);
        vm.prank(KEEPER);
        vault.claimPayout(TRADER, USDG);
        vm.expectRevert(FloatVault.Unauthorized.selector);
        vm.prank(KEEPER);
        vault.collect(USDG);
    }

    function testAdminConfigurationRejectsZeroAndInvalidValues() public {
        vm.expectRevert(FloatOracle.ZeroAddress.selector);
        oracle.setSigner(address(0));
        vm.expectRevert(FloatOracle.ZeroAddress.selector);
        oracle.scheduleOwnershipTransfer(address(0));
        vm.expectRevert(FloatVault.ZeroAddress.selector);
        vault.setClearingHouse(address(0));
        vm.expectRevert(FloatVault.ZeroAddress.selector);
        vault.scheduleOwnershipTransfer(address(0));
        vm.expectRevert(FloatClearingHouse.ZeroAddress.selector);
        clearing.setQuoteSigner(address(0));
        vm.expectRevert(FloatClearingHouse.ZeroAddress.selector);
        clearing.setFeeRecipient(address(0));
        vm.expectRevert(FloatClearingHouse.ZeroAmount.selector);
        clearing.setOracleMaxAgeSeconds(0);

        FloatClearingHouse.Market memory market = clearing.getMarket(MARKET_A);
        market.state = FloatClearingHouse.MarketState.Unset;
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maxLeverageE18 = uint64(E18 - 1);
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maintenanceMarginBps = 0;
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maintenanceMarginBps = 10_000;
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maxExecutionDeviationBps = 751;
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maxOracleConfidenceBps = 10_001;
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maxPositionNotionalUsdg = 0;
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maxLeverageE18 = uint64(E18 + 1);
        market.maintenanceMarginBps = 9_999;
        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.setMarket(MARKET_A, market);
    }

    function testEmptyAndEarlyTimelockApplicationsRevert() public {
        vm.expectRevert(FloatClearingHouse.NoPendingChange.selector);
        clearing.applyMarket(MARKET_A);
        vm.expectRevert(FloatClearingHouse.NoPendingChange.selector);
        clearing.applyQuoteSigner();
        vm.expectRevert(FloatClearingHouse.NoPendingChange.selector);
        clearing.applyOracleMaxAgeSeconds();
        vm.expectRevert(FloatOracle.NoPendingChange.selector);
        oracle.applySigner();
        vm.expectRevert(FloatOracle.NoPendingChange.selector);
        oracle.applyMarketEnabled(MARKET_A);
        vm.expectRevert(FloatVault.Unauthorized.selector);
        vault.acceptOwnership();

        FloatClearingHouse.Market memory changed = clearing.getMarket(MARKET_A);
        changed.maxLeverageE18 = uint64(6 * E18);
        clearing.setMarket(MARKET_A, changed);
        clearing.applyMarket(MARKET_A);
        clearing.setQuoteSigner(TRADER);
        clearing.applyQuoteSigner();
        clearing.setOracleMaxAgeSeconds(180);
        clearing.applyOracleMaxAgeSeconds();
        oracle.setSigner(TRADER);
        oracle.applySigner();
    }

    function testZeroDelayConfigAppliesAtCurrentTimestamp() public {
        FloatClearingHouse.Market memory changed = clearing.getMarket(MARKET_A);
        changed.maxLeverageE18 = uint64(6 * E18);
        clearing.setMarket(MARKET_A, changed);
        uint256 scheduledAt = block.timestamp;
        vm.warp(scheduledAt - 1);
        vm.expectRevert(FloatClearingHouse.TimelockNotReady.selector);
        clearing.applyMarket(MARKET_A);
        vm.warp(scheduledAt);
        clearing.applyMarket(MARKET_A);
        clearing.setQuoteSigner(TRADER);
        scheduledAt = block.timestamp;
        vm.warp(scheduledAt - 1);
        vm.expectRevert(FloatClearingHouse.TimelockNotReady.selector);
        clearing.applyQuoteSigner();
        vm.warp(scheduledAt);
        clearing.applyQuoteSigner();
        clearing.setOracleMaxAgeSeconds(180);
        scheduledAt = block.timestamp;
        vm.warp(scheduledAt - 1);
        vm.expectRevert(FloatClearingHouse.TimelockNotReady.selector);
        clearing.applyOracleMaxAgeSeconds();
        vm.warp(scheduledAt);
        clearing.applyOracleMaxAgeSeconds();
        clearing.scheduleOwnershipTransfer(TRADER);
        scheduledAt = block.timestamp;
        vm.warp(scheduledAt - 1);
        vm.expectRevert(FloatClearingHouse.TimelockNotReady.selector);
        vm.prank(TRADER);
        clearing.acceptOwnership();
        vm.warp(scheduledAt);
        vm.prank(TRADER);
        clearing.acceptOwnership();
        assertEq(clearing.owner(), TRADER);

        vault.scheduleOwnershipTransfer(TRADER_TWO);
        scheduledAt = block.timestamp;
        vm.warp(scheduledAt - 1);
        vm.expectRevert(FloatVault.TimelockNotReady.selector);
        vm.prank(TRADER_TWO);
        vault.acceptOwnership();
        vm.warp(scheduledAt);
        vm.prank(TRADER_TWO);
        vault.acceptOwnership();
        assertEq(vault.owner(), TRADER_TWO);
    }

    function testConstructorRejectsZeroAddressesAndMismatchedVaultAsset() public {
        vm.expectRevert(FloatClearingHouse.ZeroAddress.selector);
        new FloatClearingHouse(
            address(0), address(token), address(vault), address(oracle), vm.addr(QUOTE_KEY), address(this), 120
        );
        vm.expectRevert(FloatClearingHouse.ZeroAddress.selector);
        new FloatClearingHouse(
            address(this), address(this), address(vault), address(oracle), vm.addr(QUOTE_KEY), address(this), 120
        );
    }

    function testQuoteEarlyRejectionsRemainEnforced() public {
        FloatClearingHouse.TradeQuote memory quote = _quote(MARKET_C, TRADER, int256(1 * E18), 100 * E18, 1, 1, 0);
        vm.expectRevert(FloatClearingHouse.MarketNotActive.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _signQuote(quote));

        quote = _quote(MARKET_A, TRADER_TWO, int256(1 * E18), 100 * E18, 1, 2, 0);
        vm.expectRevert(FloatClearingHouse.InvalidDirection.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _signQuote(quote));

        quote = _quote(MARKET_A, TRADER, 0, 100 * E18, 1, 3, 0);
        vm.expectRevert(FloatClearingHouse.InvalidDirection.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _signQuote(quote));

        quote = _quote(MARKET_A, TRADER, int256(1 * E18), 100 * E18, 1, 4, 0);
        quote.expiry = uint64(block.timestamp - 1);
        vm.expectRevert(FloatClearingHouse.QuoteExpired.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _signQuote(quote));

        quote = _quote(MARKET_A, TRADER, int256(1 * E18), 100 * E18, 99, 5, 0);
        vm.expectRevert(FloatClearingHouse.OracleSequenceMismatch.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _signQuote(quote));

        quote = _quote(MARKET_A, TRADER, int256(1 * E18), 100 * E18, 1, 6, 0);
        quote.maxLeverageE18 = 4 * E18;
        vm.expectRevert(FloatClearingHouse.InvalidQuoteSignature.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _signQuote(quote));

        vm.prank(TRADER);
        clearing.cancelQuotesBefore(8);
        quote = _quote(MARKET_A, TRADER, int256(1 * E18), 100 * E18, 1, 7, 0);
        vm.expectRevert(FloatClearingHouse.QuoteUsed.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _signQuote(quote));

        vm.prank(TRADER);
        clearing.cancelQuote(8);
        quote = _quote(MARKET_A, TRADER, int256(1 * E18), 100 * E18, 1, 8, 0);
        vm.expectRevert(FloatClearingHouse.QuoteUsed.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _signQuote(quote));
    }

    function testMarginAdministrationRejectsInvalidAmountsAndMarketStates() public {
        vm.expectRevert(FloatClearingHouse.MarketNotActive.selector);
        vm.prank(TRADER);
        clearing.depositMargin(MARKET_C, USDG);
        vm.expectRevert(FloatClearingHouse.ZeroAmount.selector);
        vm.prank(TRADER);
        clearing.depositMargin(MARKET_A, 0);
        vm.expectRevert(FloatClearingHouse.PositionLimitExceeded.selector);
        vm.prank(TRADER);
        clearing.depositMargin(MARKET_A, uint256(type(int256).max) + 1);
        vm.expectRevert(FloatClearingHouse.InsufficientMargin.selector);
        vm.prank(TRADER);
        clearing.withdrawMargin(MARKET_A, 1);

        _depositMargin(20_000 * USDG);
        _execute(_quote(MARKET_A, TRADER, int256(10 * E18), 100 * E18, 1, 1, 0));
        _depositMargin(USDG);
        assertEq(clearing.totalOpenPositionMarginUsdg(), clearing.getPosition(TRADER, MARKET_A).marginUsdg);
    }

    function testVaultQueueGuardsAndFailedTokenTransfers() public {
        MockUsdG localToken = new MockUsdG();
        vm.expectRevert(FloatVault.ZeroAddress.selector);
        new FloatVault(address(0), address(localToken));
        vm.expectRevert(FloatVault.ZeroAddress.selector);
        new FloatVault(address(this), address(0));

        vm.expectRevert(FloatVault.QueueNotReady.selector);
        vault.startNextQueueEpoch();
        vm.expectRevert(FloatVault.QueueNotReady.selector);
        vault.settleQueue();
        vm.expectRevert(FloatVault.QueueNotReady.selector);
        vault.claimDeposit(vault.queueEpoch());
        vm.expectRevert(FloatVault.ZeroAmount.selector);
        vault.deposit(0, address(this));
        vm.expectRevert(FloatVault.ZeroAmount.selector);
        vault.withdraw(0, address(this));
        vm.expectRevert(FloatVault.InsufficientShares.selector);
        vault.withdraw(lpShares + 1, address(this));

        token.setBlockedRecipient(address(vault), true);
        vm.expectRevert(FloatVault.TransferFailed.selector);
        vault.deposit(USDG, address(this));
        token.setBlockedRecipient(address(vault), false);

        address receiver = address(0x9999);
        vault.withdraw(lpShares / 2, receiver);
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        vault.settleQueue();
        token.setBlockedRecipient(receiver, true);
        vm.expectRevert(FloatVault.TransferFailed.selector);
        vault.claimWithdrawal(vault.queueEpoch(), receiver);
    }

    function testMarketCapacityRiskChangesAndImmediateOwnershipTransfer() public {
        FloatClearingHouse.Market memory market = clearing.getMarket(MARKET_A);
        market.state = FloatClearingHouse.MarketState.Paused;
        for (uint256 i; i < 8; ++i) {
            clearing.setMarket(keccak256(abi.encode("EXTRA", i)), market);
        }
        vm.expectRevert(FloatClearingHouse.TooManyMarkets.selector);
        clearing.setMarket(keccak256("OVER-CAP"), market);

        market = clearing.getMarket(MARKET_A);
        market.maxLeverageE18 += uint64(E18);
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maintenanceMarginBps -= 1;
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maxExecutionDeviationBps += 1;
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maxOracleConfidenceBps += 1;
        clearing.setMarket(MARKET_A, market);
        market = clearing.getMarket(MARKET_A);
        market.maxPositionNotionalUsdg += uint128(USDG);
        clearing.setMarket(MARKET_A, market);

        vm.expectRevert(FloatClearingHouse.InvalidRiskParameters.selector);
        clearing.deregisterMarket(MARKET_C);
        clearing.setOracleMaxAgeSeconds(60);
        assertEq(clearing.oracleMaxAgeSeconds(), 60);
        clearing.scheduleOwnershipTransfer(TRADER);
        vm.expectRevert(FloatClearingHouse.Unauthorized.selector);
        clearing.acceptOwnership();
        vm.prank(TRADER);
        clearing.acceptOwnership();
        assertEq(clearing.owner(), TRADER);
    }

    function testEmptyClaimsAndPayoutEdges() public {
        vm.expectRevert(FloatClearingHouse.ZeroAddress.selector);
        clearing.claim(address(0));
        vm.expectRevert(FloatClearingHouse.NothingToClaim.selector);
        clearing.claim(TRADER);
        vm.expectRevert(FloatClearingHouse.ZeroAddress.selector);
        clearing.claimDeferred(address(0));
        vm.expectRevert(FloatClearingHouse.NothingToClaim.selector);
        clearing.claimDeferred(TRADER);

        vm.expectRevert(FloatVault.ZeroAddress.selector);
        vm.prank(address(clearing));
        vault.claimPayout(address(0), USDG);
        vm.expectRevert(FloatVault.ZeroAmount.selector);
        vm.prank(address(clearing));
        vault.claimPayout(TRADER, 0);
        vm.expectRevert(FloatVault.ZeroAmount.selector);
        vm.prank(address(clearing));
        vault.fundInsuranceFromClearingHouse(0);
        vm.prank(address(clearing));
        vault.collect(0);
    }

    function testMalformedTradeSignaturesAndPausedMarginRules() public {
        _depositMargin(20_000 * USDG);
        FloatClearingHouse.TradeQuote memory quote = _quote(MARKET_A, TRADER, int256(10 * E18), 100 * E18, 1, 1, 0);
        vm.expectRevert(FloatClearingHouse.InvalidQuoteSignature.selector);
        vm.prank(TRADER);
        clearing.execute(quote, hex"1234");

        bytes memory invalidV = new bytes(65);
        invalidV[64] = bytes1(uint8(29));
        vm.expectRevert(FloatClearingHouse.InvalidQuoteSignature.selector);
        vm.prank(TRADER);
        clearing.execute(quote, invalidV);

        bytes memory highS = new bytes(65);
        for (uint256 i; i < 32; ++i) {
            highS[32 + i] = bytes1(uint8(0xff));
        }
        highS[64] = bytes1(uint8(27));
        vm.expectRevert(FloatClearingHouse.InvalidQuoteSignature.selector);
        vm.prank(TRADER);
        clearing.execute(quote, highS);

        _execute(quote);
        FloatClearingHouse.Market memory market = clearing.getMarket(MARKET_A);
        market.state = FloatClearingHouse.MarketState.Paused;
        clearing.setMarket(MARKET_A, market);
        vm.expectRevert(FloatClearingHouse.MarketPaused.selector);
        vm.prank(TRADER);
        clearing.withdrawMargin(MARKET_A, USDG);
        vm.expectRevert(FloatClearingHouse.InsufficientMargin.selector);
        vm.prank(TRADER);
        clearing.withdrawMargin(MARKET_A, 0);
    }

    function invariant_registeredMarketsRespectHardQuoteBound() public view {
        for (uint256 i; i < clearing.marketCount(); ++i) {
            FloatClearingHouse.Market memory market = clearing.getMarket(clearing.marketIdAt(i));
            assertLe(market.maxExecutionDeviationBps, clearing.MAX_QUOTE_ORACLE_DEVIATION_BPS());
        }
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
