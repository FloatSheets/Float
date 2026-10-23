// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IInstantVaultToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IInstantVaultClearingHouse {
    function availableLiquidity() external view returns (uint256);
    function navPricesFresh() external view returns (bool);
    function unrealizedPnlUsdg() external view returns (int256);
    function totalOpenPositionMarginUsdg() external view returns (uint256);
}

/// @notice Instant LP vault for Jaguar. Withdrawals are atomic and limited to
/// liquid assets that remain available after the clearing house's risk reserve.
contract FloatInstantVault {
    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientShares();
    error TransferFailed();
    error InsufficientAvailableLiquidity();
    error ClearingHouseAlreadySet();
    error ClearingHouseNotSet();
    error Reentrant();
    error TimelockNotReady();
    error StaleNav();

    IInstantVaultToken public immutable asset;
    address public owner;
    address public clearingHouse;
    uint256 public totalShares;
    address public pendingOwner;
    uint64 public pendingOwnerAt;
    uint64 public constant CONFIG_DELAY = 0;
    uint256 public totalPayoutOwed;
    uint256 public insuranceAssets;
    uint256 public hourlyPayoutCap;
    uint256 public hourlyPayoutUsed;
    uint256 public hourlyPayoutHour;
    bool public hourlyPayoutInitialized;
    uint256 private entered;

    uint256 public constant VIRTUAL_ASSETS = 1;
    uint256 public constant VIRTUAL_SHARES = 1e6;
    uint256 public constant MAX_HOURLY_PAYOUT_BPS = 500;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public payoutOwed;

    event Deposit(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event ClearingHouseUpdated(address indexed clearingHouse);
    event Payout(address indexed receiver, uint256 assets);
    event Collection(address indexed payer, uint256 assets);
    event InsuranceFunded(address indexed payer, uint256 assets);
    event InsuranceUsed(uint256 assets);
    event OwnershipTransferStarted(address indexed pendingOwner, uint64 effectiveAt);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner, address settlementAsset) {
        if (initialOwner == address(0) || settlementAsset == address(0)) revert ZeroAddress();
        owner = initialOwner;
        asset = IInstantVaultToken(settlementAsset);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyClearingHouse() {
        if (msg.sender != clearingHouse) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered == 1) revert Reentrant();
        entered = 1;
        _;
        entered = 0;
    }

    function scheduleOwnershipTransfer(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert ZeroAddress();
        pendingOwner = nextOwner;
        pendingOwnerAt = uint64(block.timestamp + CONFIG_DELAY);
        emit OwnershipTransferStarted(nextOwner, pendingOwnerAt);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        if (block.timestamp < pendingOwnerAt) revert TimelockNotReady();
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        pendingOwnerAt = 0;
        emit OwnershipTransferred(previousOwner, owner);
    }

    function setClearingHouse(address newClearingHouse) external onlyOwner {
        if (newClearingHouse == address(0)) revert ZeroAddress();
        if (clearingHouse != address(0)) revert ClearingHouseAlreadySet();
        clearingHouse = newClearingHouse;
        emit ClearingHouseUpdated(newClearingHouse);
    }

    function totalAssets() public view returns (uint256) {
        uint256 balance = asset.balanceOf(address(this));
        uint256 seniorClaims = totalPayoutOwed + insuranceAssets;
        uint256 cashAssets = balance > seniorClaims ? balance - seniorClaims : 0;
        if (clearingHouse == address(0)) return cashAssets;
        IInstantVaultClearingHouse clearing = IInstantVaultClearingHouse(clearingHouse);
        if (!clearing.navPricesFresh()) return 0;
        int256 pnl = clearing.unrealizedPnlUsdg();
        if (pnl > 0) {
            uint256 liability = uint256(pnl);
            return liability >= cashAssets ? 0 : cashAssets - liability;
        }
        if (pnl < 0) {
            uint256 loss = uint256(-(pnl + 1)) + 1;
            uint256 collectibleLoss = clearing.totalOpenPositionMarginUsdg();
            return cashAssets + (loss < collectibleLoss ? loss : collectibleLoss);
        }
        return cashAssets;
    }

    /// @notice Mints shares at the current NAV in the same transaction.
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (receiver == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();
        if (clearingHouse == address(0)) revert ClearingHouseNotSet();
        if (!IInstantVaultClearingHouse(clearingHouse).navPricesFresh()) revert StaleNav();
        uint256 nav = totalAssets();
        shares = assets * (totalShares + VIRTUAL_SHARES) / (nav + VIRTUAL_ASSETS);
        if (shares == 0) revert ZeroAmount();
        _safeTransferFrom(msg.sender, address(this), assets);
        totalShares += shares;
        balanceOf[receiver] += shares;
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @notice Burns shares and pays immediately, bounded by idle, unreserved liquidity.
    function withdraw(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();
        if (clearingHouse == address(0)) revert ClearingHouseNotSet();
        IInstantVaultClearingHouse clearing = IInstantVaultClearingHouse(clearingHouse);
        if (!clearing.navPricesFresh()) revert StaleNav();
        if (balanceOf[msg.sender] < shares) revert InsufficientShares();
        uint256 nav = totalAssets();
        assets = shares * (nav + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
        if (assets == 0) revert ZeroAmount();

        uint256 balance = asset.balanceOf(address(this));
        uint256 protected = totalPayoutOwed + insuranceAssets;
        uint256 cashAvailable = balance > protected ? balance - protected : 0;
        uint256 riskAvailable = clearing.availableLiquidity();
        if (assets > cashAvailable || assets > riskAvailable) revert InsufficientAvailableLiquidity();

        unchecked {
            totalShares -= shares;
            balanceOf[msg.sender] -= shares;
        }
        _safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, assets, shares);
    }

    function fundInsurance(uint256 assets) external nonReentrant {
        if (assets == 0) revert ZeroAmount();
        _safeTransferFrom(msg.sender, address(this), assets);
        insuranceAssets += assets;
        emit InsuranceFunded(msg.sender, assets);
    }

    function fundInsuranceFromClearingHouse(uint256 assets) external nonReentrant onlyClearingHouse {
        if (assets == 0) revert ZeroAmount();
        _safeTransferFrom(msg.sender, address(this), assets);
        insuranceAssets += assets;
        emit InsuranceFunded(msg.sender, assets);
    }

    function payout(address receiver, uint256 assets) external nonReentrant onlyClearingHouse returns (uint256 paid) {
        if (assets == 0) return 0;
        uint256 allowed = _hourlyAllowance(assets);
        uint256 insured = _useInsurance(allowed);
        if (insured != 0) {
            _safeTransfer(receiver, insured);
            paid = insured;
        }
        uint256 remaining = allowed - insured;
        uint256 balance = asset.balanceOf(address(this));
        uint256 protected = totalPayoutOwed + insuranceAssets;
        uint256 freeBalance = balance > protected ? balance - protected : 0;
        uint256 lpPaid = remaining < freeBalance ? remaining : freeBalance;
        if (lpPaid != 0) {
            _safeTransfer(receiver, lpPaid);
            paid += lpPaid;
        }
        _recordHourlyPayout(paid);
        uint256 owed = assets - paid;
        if (owed != 0) {
            payoutOwed[msg.sender] += owed;
            totalPayoutOwed += owed;
        }
        emit Payout(receiver, paid);
    }

    function claimPayout(address receiver, uint256 assets)
        external
        nonReentrant
        onlyClearingHouse
        returns (uint256 paid)
    {
        if (receiver == address(0)) revert ZeroAddress();
        uint256 owed = payoutOwed[msg.sender];
        if (assets == 0 || owed == 0) revert ZeroAmount();
        uint256 requested = assets < owed ? assets : owed;
        uint256 allowed = _hourlyAllowance(requested);
        uint256 insurancePaid = _useInsurance(allowed);
        if (insurancePaid != 0) {
            owed -= insurancePaid;
            payoutOwed[msg.sender] = owed;
            totalPayoutOwed -= insurancePaid;
            _safeTransfer(receiver, insurancePaid);
            paid = insurancePaid;
        }
        uint256 balance = asset.balanceOf(address(this));
        uint256 otherOwed = totalPayoutOwed - owed;
        uint256 protected = otherOwed + insuranceAssets;
        uint256 available = balance > protected ? balance - protected : 0;
        uint256 lpPaid = allowed - insurancePaid;
        if (lpPaid > owed) lpPaid = owed;
        if (lpPaid > available) lpPaid = available;
        if (lpPaid != 0) {
            payoutOwed[msg.sender] = owed - lpPaid;
            totalPayoutOwed -= lpPaid;
            _safeTransfer(receiver, lpPaid);
            paid += lpPaid;
        }
        _recordHourlyPayout(paid);
        if (paid != 0) emit Payout(receiver, paid);
    }

    function collect(uint256 assets) external nonReentrant onlyClearingHouse {
        if (assets != 0) {
            _safeTransferFrom(msg.sender, address(this), assets);
            emit Collection(msg.sender, assets);
        }
    }

    function _hourlyAllowance(uint256 requested) private returns (uint256 allowed) {
        uint256 hour = block.timestamp / 1 hours;
        if (!hourlyPayoutInitialized || hour != hourlyPayoutHour) {
            hourlyPayoutInitialized = true;
            hourlyPayoutHour = hour;
            hourlyPayoutCap = 0;
            hourlyPayoutUsed = 0;
        }
        uint256 currentCap = (totalAssets() + insuranceAssets) * MAX_HOURLY_PAYOUT_BPS / 10_000;
        if (currentCap > hourlyPayoutCap) hourlyPayoutCap = currentCap;
        uint256 remaining = hourlyPayoutCap > hourlyPayoutUsed ? hourlyPayoutCap - hourlyPayoutUsed : 0;
        allowed = requested < remaining ? requested : remaining;
    }

    function _recordHourlyPayout(uint256 paid) private {
        hourlyPayoutUsed += paid;
    }

    function _useInsurance(uint256 needed) private returns (uint256 used) {
        used = needed < insuranceAssets ? needed : insuranceAssets;
        if (used != 0) {
            insuranceAssets -= used;
            emit InsuranceUsed(used);
        }
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(asset).call(abi.encodeCall(IInstantVaultToken.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(asset).call(abi.encodeCall(IInstantVaultToken.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
