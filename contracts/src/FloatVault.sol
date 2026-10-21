// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IFloatClearingLiquidity {
    function availableLiquidity() external view returns (uint256);
    function activePositionCount() external view returns (uint256);
    function unrealizedPnlUsdg() external view returns (int256);
    function totalOpenPositionMarginUsdg() external view returns (uint256);
}

/// @notice A single USDG liquidity vault. The clearing house alone may realize trader PnL.
contract FloatVault {
    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientShares();
    error TransferFailed();
    error InsufficientAvailableLiquidity();
    error ClearingHouseAlreadySet();
    error ClearingHouseNotSet();
    error Reentrant();
    error LiquidityLocked();
    error QueueNotReady();
    error QueueAlreadySettled();
    error NothingQueued();
    error InsufficientQueuedShares();

    IERC20 public immutable asset;
    address public owner;
    address public clearingHouse;
    uint256 public totalShares;
    uint256 public totalPayoutOwed;
    uint256 public totalWithdrawalOwed;
    uint256 public pendingDepositAssets;
    uint256 public insuranceAssets;
    uint64 public queueEpochStartedAt;
    uint64 public queueEpoch;
    bool public queueEpochSettled;
    uint256 public settledDepositAssets;
    uint256 public settledDepositShares;
    uint256 public settledWithdrawalShares;
    uint256 public settledWithdrawalAssets;
    uint256 public settledWithdrawalRemaining;
    uint256 public queuedDepositClaimsRemaining;
    uint256 public queuedWithdrawalClaimsRemaining;
    uint256 public settledNav;
    uint256 public settledShareSupply;
    struct QueueSettlement {
        uint256 nav;
        uint256 shareSupply;
        uint256 depositAssets;
        uint256 depositShares;
        uint256 withdrawalShares;
        uint256 withdrawalAssets;
        uint256 withdrawalRemaining;
        uint256 withdrawalClaimsRemaining;
        bool settled;
    }
    mapping(uint64 => QueueSettlement) public queueSettlements;
    uint256 public constant QUEUE_EPOCH_DURATION = 1 days;
    uint256 public constant VIRTUAL_ASSETS = 1;
    uint256 public constant VIRTUAL_SHARES = 1e6;
    uint256 private entered;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public payoutOwed;
    mapping(uint64 => mapping(address => uint256)) public queuedDepositOf;
    mapping(uint64 => mapping(address => uint256)) public queuedWithdrawalOf;
    mapping(address => uint256) public lockedWithdrawalShares;
    mapping(uint64 => mapping(address => bool)) public depositClaimed;
    mapping(uint64 => mapping(address => bool)) public withdrawalClaimed;
    mapping(uint64 => mapping(address => bool)) private hasQueuedDeposit;
    mapping(uint64 => mapping(address => bool)) private hasQueuedWithdrawal;
    mapping(uint64 => mapping(address => address)) public queuedWithdrawalReceiver;

    event Deposit(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event ClearingHouseUpdated(address indexed clearingHouse);
    event Payout(address indexed receiver, uint256 assets);
    event Collection(address indexed payer, uint256 assets);
    event DepositQueued(uint64 indexed epoch, address indexed account, uint256 assets);
    event WithdrawalQueued(uint64 indexed epoch, address indexed account, uint256 shares);
    event QueueEpochSettled(uint64 indexed epoch, uint256 nav, uint256 shareSupply, uint256 depositShares, uint256 withdrawalAssets);
    event QueuedDepositClaimed(uint64 indexed epoch, address indexed account, uint256 shares);
    event QueuedWithdrawalClaimed(uint64 indexed epoch, address indexed account, uint256 assets);
    event InsuranceFunded(address indexed payer, uint256 assets);
    event InsuranceUsed(uint256 assets);

    constructor(address initialOwner, address settlementAsset) {
        if (initialOwner == address(0) || settlementAsset == address(0)) revert ZeroAddress();
        owner = initialOwner;
        asset = IERC20(settlementAsset);
        queueEpochStartedAt = uint64(block.timestamp);
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

    function totalAssets() public view returns (uint256) {
        uint256 balance = asset.balanceOf(address(this));
        uint256 seniorClaims = totalPayoutOwed + totalWithdrawalOwed + pendingDepositAssets + insuranceAssets;
        uint256 cashAssets = balance > seniorClaims ? balance - seniorClaims : 0;
        if (clearingHouse == address(0)) return cashAssets;
        int256 pnl = IFloatClearingLiquidity(clearingHouse).unrealizedPnlUsdg();
        if (pnl > 0) {
            uint256 liability = uint256(pnl);
            return liability >= cashAssets ? 0 : cashAssets - liability;
        }
        if (pnl < 0) {
            uint256 loss = uint256(-(pnl + 1)) + 1;
            uint256 collectibleLoss = IFloatClearingLiquidity(clearingHouse).totalOpenPositionMarginUsdg();
            return cashAssets + (loss < collectibleLoss ? loss : collectibleLoss);
        }
        return cashAssets;
    }

    function setClearingHouse(address newClearingHouse) external onlyOwner {
        if (newClearingHouse == address(0)) revert ZeroAddress();
        if (clearingHouse != address(0)) revert ClearingHouseAlreadySet();
        clearingHouse = newClearingHouse;
        emit ClearingHouseUpdated(newClearingHouse);
    }

    /// @notice Queues a USDG deposit for the next epoch. Shares are issued at the epoch NAV.
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        _ensureActiveQueueEpoch();
        if (receiver == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();
        if (clearingHouse == address(0)) revert ClearingHouseNotSet();
        uint256 assetsBefore = totalAssets();
        shares = assets * (totalShares + VIRTUAL_SHARES) / (assetsBefore + VIRTUAL_ASSETS);
        if (shares == 0) revert ZeroAmount();
        if (!hasQueuedDeposit[queueEpoch][receiver]) {
            hasQueuedDeposit[queueEpoch][receiver] = true;
            ++queuedDepositClaimsRemaining;
        }
        queuedDepositOf[queueEpoch][receiver] += assets;
        pendingDepositAssets += assets;
        _safeTransferFrom(msg.sender, address(this), assets);
        emit DepositQueued(queueEpoch, receiver, assets);
    }

    /// @notice Queues a share redemption for the next epoch. Shares cannot be queued twice.
    function withdraw(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        _ensureActiveQueueEpoch();
        if (receiver == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < lockedWithdrawalShares[msg.sender] + shares) revert InsufficientShares();
        assets = shares * (totalAssets() + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
        if (clearingHouse == address(0)) revert ClearingHouseNotSet();
        queuedWithdrawalOf[queueEpoch][msg.sender] += shares;
        lockedWithdrawalShares[msg.sender] += shares;
        queuedWithdrawalTotal[queueEpoch] += shares;
        queuedWithdrawalReceiver[queueEpoch][msg.sender] = receiver;
        if (!hasQueuedWithdrawal[queueEpoch][msg.sender]) {
            hasQueuedWithdrawal[queueEpoch][msg.sender] = true;
            ++queuedWithdrawalAccountsCount[queueEpoch];
            ++queuedWithdrawalClaimsRemaining;
        }
        emit WithdrawalQueued(queueEpoch, msg.sender, shares);
    }

    /// @notice Prices all LP requests in the current epoch from one NAV snapshot.
    function settleQueue() external nonReentrant {
        if (queueEpochSettled) revert QueueAlreadySettled();
        if (block.timestamp < uint256(queueEpochStartedAt) + QUEUE_EPOCH_DURATION) revert QueueNotReady();
        uint256 nav = totalAssets();
        uint256 supply = totalShares;
        uint256 depositShares = pendingDepositAssets * (supply + VIRTUAL_SHARES) / (nav + VIRTUAL_ASSETS);
        uint256 withdrawalShares = _queuedWithdrawalShares(queueEpoch);
        uint256 withdrawalAssets = withdrawalShares * (nav + VIRTUAL_ASSETS) / (supply + VIRTUAL_SHARES);
        if (withdrawalAssets > IFloatClearingLiquidity(clearingHouse).availableLiquidity()) {
            revert InsufficientAvailableLiquidity();
        }
        settledNav = nav;
        settledShareSupply = supply;
        settledDepositAssets = pendingDepositAssets;
        settledDepositShares = depositShares;
        settledWithdrawalShares = withdrawalShares;
        settledWithdrawalAssets = withdrawalAssets;
        settledWithdrawalRemaining = withdrawalAssets;
        queueSettlements[queueEpoch] = QueueSettlement({
            nav: nav,
            shareSupply: supply,
            depositAssets: pendingDepositAssets,
            depositShares: depositShares,
            withdrawalShares: withdrawalShares,
            withdrawalAssets: withdrawalAssets,
            withdrawalRemaining: withdrawalAssets,
            withdrawalClaimsRemaining: queuedWithdrawalAccountsCount[queueEpoch],
            settled: true
        });
        totalShares = supply + depositShares - withdrawalShares;
        pendingDepositAssets = 0;
        totalWithdrawalOwed += withdrawalAssets;
        queueEpochSettled = true;
        emit QueueEpochSettled(queueEpoch, nav, supply, depositShares, withdrawalAssets);
    }

    function claimDeposit(uint64 epoch) external nonReentrant returns (uint256 shares) {
        QueueSettlement memory settlement = queueSettlements[epoch];
        if (!settlement.settled) revert QueueNotReady();
        if (depositClaimed[epoch][msg.sender]) revert NothingQueued();
        uint256 assets = queuedDepositOf[epoch][msg.sender];
        if (assets == 0 || settlement.depositAssets == 0) revert NothingQueued();
        depositClaimed[epoch][msg.sender] = true;
        --queuedDepositClaimsRemaining;
        shares = assets * (settlement.shareSupply + VIRTUAL_SHARES) / (settlement.nav + VIRTUAL_ASSETS);
        balanceOf[msg.sender] += shares;
        emit Deposit(msg.sender, msg.sender, assets, shares);
        emit QueuedDepositClaimed(epoch, msg.sender, shares);
    }

    function claimWithdrawal(uint64 epoch, address receiver) external nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert ZeroAddress();
        QueueSettlement storage settlement = queueSettlements[epoch];
        if (!settlement.settled) revert QueueNotReady();
        if (withdrawalClaimed[epoch][msg.sender]) revert NothingQueued();
        uint256 shares = queuedWithdrawalOf[epoch][msg.sender];
        if (shares == 0 || settlement.withdrawalShares == 0) revert NothingQueued();
        if (balanceOf[msg.sender] < shares) revert InsufficientShares();
        assets = shares * (settlement.nav + VIRTUAL_ASSETS) / (settlement.shareSupply + VIRTUAL_SHARES);
        uint256 balance = asset.balanceOf(address(this));
        uint256 protected = totalPayoutOwed + insuranceAssets + (totalWithdrawalOwed - settlement.withdrawalRemaining);
        uint256 available = balance > protected ? balance - protected : 0;
        if (assets > available) revert InsufficientAvailableLiquidity();
        withdrawalClaimed[epoch][msg.sender] = true;
        --queuedWithdrawalClaimsRemaining;
        --settlement.withdrawalClaimsRemaining;
        lockedWithdrawalShares[msg.sender] -= shares;
        balanceOf[msg.sender] -= shares;
        totalWithdrawalOwed -= assets;
        settlement.withdrawalRemaining -= assets;
        address recipient = queuedWithdrawalReceiver[epoch][msg.sender];
        if (recipient == address(0)) recipient = receiver;
        _safeTransfer(recipient, assets);
        emit Withdraw(msg.sender, recipient, assets, shares);
        emit QueuedWithdrawalClaimed(epoch, msg.sender, assets);
        if (settlement.withdrawalClaimsRemaining == 0 && settlement.withdrawalRemaining != 0) {
            totalWithdrawalOwed -= settlement.withdrawalRemaining;
            settlement.withdrawalRemaining = 0;
        }
    }

    function startNextQueueEpoch() external nonReentrant {
        if (!queueEpochSettled) revert QueueNotReady();
        _startNextQueueEpoch();
    }

    function _ensureActiveQueueEpoch() private {
        if (queueEpochSettled) _startNextQueueEpoch();
    }

    function _startNextQueueEpoch() private {
        ++queueEpoch;
        queueEpochStartedAt = uint64(block.timestamp);
        queueEpochSettled = false;
        settledNav = 0;
        settledShareSupply = 0;
        settledDepositAssets = 0;
        settledDepositShares = 0;
        settledWithdrawalShares = 0;
        settledWithdrawalAssets = 0;
        settledWithdrawalRemaining = 0;
    }

    function _queuedWithdrawalShares(uint64 epoch) private view returns (uint256 shares) {
        // The share balances are not enumerable. Requests aggregate through this counter.
        shares = queuedWithdrawalTotal[epoch];
    }

    mapping(uint64 => uint256) public queuedWithdrawalTotal;
    mapping(uint64 => uint256) public queuedWithdrawalAccountsCount;

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

    function _useInsurance(uint256 needed) private returns (uint256 used) {
        used = needed < insuranceAssets ? needed : insuranceAssets;
        if (used != 0) {
            insuranceAssets -= used;
            emit InsuranceUsed(used);
        }
    }

    /// @notice Pays what is liquid and records the remainder as a senior claim.
    /// This lets winning trader closes settle even when LP cash is temporarily insufficient.
    function payout(address receiver, uint256 assets) external nonReentrant onlyClearingHouse returns (uint256 paid) {
        if (assets != 0) {
            uint256 insured = _useInsurance(assets);
            if (insured != 0) {
                _safeTransfer(receiver, insured);
                paid = insured;
            }
            uint256 remaining = assets - insured;
            uint256 balance = asset.balanceOf(address(this));
            uint256 protected = totalPayoutOwed + totalWithdrawalOwed + insuranceAssets;
            uint256 freeBalance = balance > protected ? balance - protected : 0;
            uint256 lpPaid = remaining < freeBalance ? remaining : freeBalance;
            if (lpPaid != 0) {
                _safeTransfer(receiver, lpPaid);
                paid += lpPaid;
            }
            uint256 owed = assets - paid;
            if (owed != 0) {
                payoutOwed[msg.sender] += owed;
                totalPayoutOwed += owed;
            }
            emit Payout(receiver, paid);
        }
    }

    /// @notice Pays a previously accrued clearing-house payout claim directly to its trader.
    function claimPayout(address receiver, uint256 assets)
        external
        nonReentrant
        onlyClearingHouse
        returns (uint256 paid)
    {
        if (receiver == address(0)) revert ZeroAddress();
        uint256 owed = payoutOwed[msg.sender];
        if (assets == 0 || owed == 0) revert ZeroAmount();
        uint256 insurancePaid = _useInsurance(assets < owed ? assets : owed);
        if (insurancePaid != 0) {
            owed -= insurancePaid;
            payoutOwed[msg.sender] = owed;
            totalPayoutOwed -= insurancePaid;
            _safeTransfer(receiver, insurancePaid);
            paid = insurancePaid;
        }
        uint256 balance = asset.balanceOf(address(this));
        uint256 otherOwed = totalPayoutOwed - owed;
        uint256 protected = otherOwed + totalWithdrawalOwed + insuranceAssets;
        uint256 available = balance > protected ? balance - protected : 0;
        uint256 lpPaid = assets - insurancePaid;
        if (lpPaid > owed) lpPaid = owed;
        if (lpPaid > available) lpPaid = available;
        if (lpPaid != 0) {
            payoutOwed[msg.sender] = owed - lpPaid;
            totalPayoutOwed -= lpPaid;
            _safeTransfer(receiver, lpPaid);
            paid += lpPaid;
        }
        if (paid != 0) emit Payout(receiver, paid);
    }

    function collect(uint256 assets) external nonReentrant onlyClearingHouse {
        if (assets != 0) {
            _safeTransferFrom(msg.sender, address(this), assets);
            emit Collection(msg.sender, assets);
        }
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(asset).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(asset).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
