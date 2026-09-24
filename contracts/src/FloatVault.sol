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
    error Reentrant();

    IERC20 public immutable asset;
    address public owner;
    address public clearingHouse;
    uint256 public totalShares;
    uint256 public constant VIRTUAL_ASSETS = 1;
    uint256 public constant VIRTUAL_SHARES = 1e6;
    uint256 private entered;
    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event ClearingHouseUpdated(address indexed clearingHouse);
    event Payout(address indexed receiver, uint256 assets);
    event Collection(address indexed payer, uint256 assets);

    constructor(address initialOwner, address settlementAsset) {
        if (initialOwner == address(0) || settlementAsset == address(0)) revert ZeroAddress();
        owner = initialOwner;
        asset = IERC20(settlementAsset);
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
        return asset.balanceOf(address(this));
    }

    function setClearingHouse(address newClearingHouse) external onlyOwner {
        if (newClearingHouse == address(0)) revert ZeroAddress();
        if (clearingHouse != address(0)) revert ClearingHouseAlreadySet();
        clearingHouse = newClearingHouse;
        emit ClearingHouseUpdated(newClearingHouse);
    }

    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (receiver == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();
        uint256 assetsBefore = totalAssets();
        // Virtual liquidity prevents a first depositor from manipulating the
        // share price with a direct token donation. It also permits orderly
        // recapitalization if real assets are ever exhausted.
        shares = assets * (totalShares + VIRTUAL_SHARES) / (assetsBefore + VIRTUAL_ASSETS);
        if (shares == 0) revert ZeroAmount();
        totalShares += shares;
        balanceOf[receiver] += shares;
        _safeTransferFrom(msg.sender, address(this), assets);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < shares) revert InsufficientShares();
        assets = shares * (totalAssets() + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
        if (clearingHouse == address(0) || assets > IFloatClearingLiquidity(clearingHouse).availableLiquidity()) {
            revert InsufficientAvailableLiquidity();
        }
        balanceOf[msg.sender] -= shares;
        totalShares -= shares;
        _safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, assets, shares);
    }

    function payout(address receiver, uint256 assets) external nonReentrant onlyClearingHouse {
        if (assets != 0) {
            _safeTransfer(receiver, assets);
            emit Payout(receiver, assets);
        }
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
