// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {FloatInstantVault} from "../src/FloatInstantVault.sol";

contract InstantVaultToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfer;
    bool public failTransferFrom;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFailures(bool transfer_, bool transferFrom_) external {
        failTransfer = transfer_;
        failTransferFrom = transferFrom_;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfer) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransferFrom) return false;
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FloatInstantVaultTest is Test {
    uint256 private constant UNIT = 1e6;
    InstantVaultToken private token;
    FloatInstantVault private vault;
    bool private fresh = true;
    int256 private pnl;
    uint256 private margin;
    uint256 private liquidity = type(uint256).max;

    function setUp() public {
        token = new InstantVaultToken();
        vault = new FloatInstantVault(address(this), address(token));
        vault.setClearingHouse(address(this));
        token.mint(address(this), 10_000 * UNIT);
        token.approve(address(vault), type(uint256).max);
    }

    function navPricesFresh() external view returns (bool) {
        return fresh;
    }

    function unrealizedPnlUsdg() external view returns (int256) {
        return pnl;
    }

    function totalOpenPositionMarginUsdg() external view returns (uint256) {
        return margin;
    }

    function availableLiquidity() external view returns (uint256) {
        return liquidity;
    }

    function payoutFor(address receiver, uint256 amount) external returns (uint256) {
        return vault.payout(receiver, amount);
    }

    function claimFor(address receiver, uint256 amount) external returns (uint256) {
        return vault.claimPayout(receiver, amount);
    }

    function collectFor(uint256 amount) external {
        vault.collect(amount);
    }

    function insureFor(uint256 amount) external {
        vault.fundInsuranceFromClearingHouse(amount);
    }

    function testConstructorAndClearingHouseGuards() public {
        vm.expectRevert(FloatInstantVault.ZeroAddress.selector);
        new FloatInstantVault(address(0), address(token));
        vm.expectRevert(FloatInstantVault.ZeroAddress.selector);
        new FloatInstantVault(address(this), address(0));
        FloatInstantVault local = new FloatInstantVault(address(this), address(token));
        vm.expectRevert(FloatInstantVault.ZeroAddress.selector);
        local.setClearingHouse(address(0));
        local.setClearingHouse(address(this));
        vm.expectRevert(FloatInstantVault.ClearingHouseAlreadySet.selector);
        local.setClearingHouse(address(this));
        vm.prank(address(0xBAD));
        vm.expectRevert(FloatInstantVault.Unauthorized.selector);
        local.setClearingHouse(address(0x1234));
    }

    function testInstantDepositAndWithdrawalAtCurrentNav() public {
        uint256 shares = vault.deposit(1_000 * UNIT, address(this));
        assertEq(shares, 1_000 * UNIT * 1e6);
        assertEq(vault.balanceOf(address(this)), shares);
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 paid = vault.withdraw(shares / 2, address(0xBEEF));
        assertEq(token.balanceOf(address(0xBEEF)), paid);
        assertEq(token.balanceOf(address(this)), beforeBalance);
        assertEq(vault.balanceOf(address(this)), shares - shares / 2);
    }

    function testDepositAndWithdrawalRejectUnsafeInputsAndStaleNav() public {
        vm.expectRevert(FloatInstantVault.ZeroAddress.selector);
        vault.deposit(1, address(0));
        vm.expectRevert(FloatInstantVault.ZeroAmount.selector);
        vault.deposit(0, address(this));
        fresh = false;
        vm.expectRevert(FloatInstantVault.StaleNav.selector);
        vault.deposit(UNIT, address(this));
        vm.expectRevert(FloatInstantVault.StaleNav.selector);
        vault.withdraw(1, address(this));
        fresh = true;
        vm.expectRevert(FloatInstantVault.InsufficientShares.selector);
        vault.withdraw(1, address(this));
        vault.deposit(10 * UNIT, address(this));
        vm.expectRevert(FloatInstantVault.ZeroAmount.selector);
        vault.withdraw(0, address(this));
        vm.expectRevert(FloatInstantVault.ZeroAddress.selector);
        vault.withdraw(1, address(0));
    }

    function testTotalAssetsUsesFreshNavPnlMarginsAndSeniorClaims() public {
        assertEq(vault.totalAssets(), 0);
        token.mint(address(vault), 100 * UNIT);
        assertEq(vault.totalAssets(), 100 * UNIT);
        fresh = false;
        assertEq(vault.totalAssets(), 0);
        fresh = true;
        pnl = int256(30 * UNIT);
        assertEq(vault.totalAssets(), 70 * UNIT);
        pnl = int256(200 * UNIT);
        assertEq(vault.totalAssets(), 0);
        pnl = -int256(40 * UNIT);
        margin = 25 * UNIT;
        assertEq(vault.totalAssets(), 125 * UNIT);
        pnl = -int256(200 * UNIT);
        assertEq(vault.totalAssets(), 125 * UNIT);
        vault.fundInsurance(10 * UNIT);
        assertEq(vault.totalAssets(), 125 * UNIT);
    }

    function testLossRecognitionIsCappedByOpenPositionMargin() public {
        token.mint(address(vault), 100 * UNIT);
        pnl = -int256(10 * UNIT);
        margin = 20 * UNIT;
        assertEq(vault.totalAssets(), 110 * UNIT);
    }

    function testUnlinkedVaultReportsCashButCannotDepositOrWithdraw() public {
        FloatInstantVault unlinked = new FloatInstantVault(address(this), address(token));
        token.mint(address(unlinked), 10 * UNIT);
        assertEq(unlinked.totalAssets(), 10 * UNIT);
        vm.expectRevert(FloatInstantVault.ClearingHouseNotSet.selector);
        unlinked.deposit(UNIT, address(this));
        vm.expectRevert(FloatInstantVault.ClearingHouseNotSet.selector);
        unlinked.withdraw(1, address(this));
    }

    function testWithdrawalRespectsCashInsurancePayoutAndRiskLiquidity() public {
        uint256 shares = vault.deposit(1_000 * UNIT, address(this));
        vault.fundInsurance(100 * UNIT);
        liquidity = 0;
        vm.expectRevert(FloatInstantVault.InsufficientAvailableLiquidity.selector);
        vault.withdraw(shares, address(this));
        liquidity = 1_000 * UNIT;
        vault.withdraw(shares, address(this));
    }

    function testInsuranceAndPayoutCapRecordDeferredOwedThenClaim() public {
        vault.deposit(1_000 * UNIT, address(this));
        vault.fundInsurance(100 * UNIT);
        uint256 paid = this.payoutFor(address(0xBEEF), 100 * UNIT);
        assertEq(paid, 55 * UNIT);
        assertEq(vault.payoutOwed(address(this)), 45 * UNIT);
        assertEq(vault.hourlyPayoutUsed(), 55 * UNIT);
        vm.expectRevert(FloatInstantVault.ZeroAddress.selector);
        this.claimFor(address(0), UNIT);
        vm.expectRevert(FloatInstantVault.ZeroAmount.selector);
        this.claimFor(address(0xBEEF), 0);
        vm.prank(address(0xBAD));
        vm.expectRevert(FloatInstantVault.Unauthorized.selector);
        vault.payout(address(0xBEEF), UNIT);
        vm.warp(block.timestamp + 1 hours);
        uint256 claimed = this.claimFor(address(0xBEEF), 50 * UNIT);
        assertEq(claimed, 45 * UNIT);
        assertEq(vault.payoutOwed(address(this)), 0);
    }

    function testPayoutCanUseLpCashAndZeroPayoutIsANoop() public {
        vault.deposit(1_000 * UNIT, address(this));
        uint256 beforeBalance = token.balanceOf(address(0xBEEF));
        assertEq(this.payoutFor(address(0xBEEF), 0), 0);
        assertEq(token.balanceOf(address(0xBEEF)), beforeBalance);
        uint256 paid = this.payoutFor(address(0xBEEF), 100 * UNIT);
        assertEq(paid, 50 * UNIT);
        assertEq(token.balanceOf(address(0xBEEF)), 50 * UNIT);
        assertEq(vault.payoutOwed(address(this)), 50 * UNIT);
        vm.warp(block.timestamp + 1 hours);
        assertEq(this.claimFor(address(0xBEEF), 10 * UNIT), 10 * UNIT);
        assertEq(vault.payoutOwed(address(this)), 40 * UNIT);
    }

    function testInsuranceCanBeFundedAndClearingHouseCanCollectAssets() public {
        vault.fundInsurance(20 * UNIT);
        assertEq(vault.insuranceAssets(), 20 * UNIT);
        this.insureFor(5 * UNIT);
        assertEq(vault.insuranceAssets(), 25 * UNIT);
        vm.expectRevert(FloatInstantVault.ZeroAmount.selector);
        this.insureFor(0);
        this.collectFor(7 * UNIT);
        assertEq(token.balanceOf(address(vault)), 32 * UNIT);
        vm.prank(address(0xBAD));
        vm.expectRevert(FloatInstantVault.Unauthorized.selector);
        vault.collect(1);
        vm.expectRevert(FloatInstantVault.ZeroAmount.selector);
        vault.fundInsurance(0);
    }

    function testTransferFailuresRevertAndOwnershipCanTransferImmediately() public {
        vm.expectRevert(FloatInstantVault.Unauthorized.selector);
        vm.prank(address(0xBAD));
        vault.scheduleOwnershipTransfer(address(0xBEEF));
        token.setFailures(false, true);
        vm.expectRevert(FloatInstantVault.TransferFailed.selector);
        vault.deposit(UNIT, address(this));
        token.setFailures(true, false);
        vault.deposit(10 * UNIT, address(this));
        uint256 shares = vault.balanceOf(address(this));
        vm.expectRevert(FloatInstantVault.TransferFailed.selector);
        vault.withdraw(shares, address(this));
        vm.expectRevert(FloatInstantVault.ZeroAddress.selector);
        vault.scheduleOwnershipTransfer(address(0));
        vault.scheduleOwnershipTransfer(address(0xBEEF));
        assertEq(vault.pendingOwner(), address(0xBEEF));
        vm.prank(address(0xBAD));
        vm.expectRevert(FloatInstantVault.Unauthorized.selector);
        vault.acceptOwnership();
        vm.prank(address(0xBEEF));
        vault.acceptOwnership();
        assertEq(vault.owner(), address(0xBEEF));
    }

    function testOwnershipTransferRejectsAcceptanceBeforeEffectiveTime() public {
        vault.scheduleOwnershipTransfer(address(0xBEEF));
        uint64 effectiveAt = vault.pendingOwnerAt();
        vm.warp(uint256(effectiveAt) - 1);
        vm.prank(address(0xBEEF));
        vm.expectRevert(FloatInstantVault.TimelockNotReady.selector);
        vault.acceptOwnership();
        vm.warp(effectiveAt);
        vm.prank(address(0xBEEF));
        vault.acceptOwnership();
        assertEq(vault.owner(), address(0xBEEF));
    }
}
