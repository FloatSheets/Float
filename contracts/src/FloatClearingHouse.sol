// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20, FloatVault} from "./FloatVault.sol";

interface IFloatOracle {
    struct Price {
        uint256 priceE18;
        uint256 confidenceBps;
        uint64 timestamp;
        uint64 sequence;
    }
    function getPrice(bytes32 marketId) external view returns (Price memory);
}

/// @notice USDG-settled, pool-vs-trader clearing with isolated market margin and a shared LP vault.
contract FloatClearingHouse {
    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error Reentrant();
    error MarketNotActive();
    error MarketPaused();
    error QuoteExpired();
    error QuoteUsed();
    error InvalidQuoteSignature();
    error StaleOraclePrice();
    error OracleSequenceMismatch();
    error OracleConfidenceTooLow();
    error ExecutionPriceOutOfBounds();
    error InvalidDirection();
    error PositionLimitExceeded();
    error OpenInterestLimitExceeded();
    error SkewLimitExceeded();
    error UtilizationLimitExceeded();
    error InsufficientMargin();
    error PositionNotLiquidatable();
    error TransferFailed();
    error TooManyMarkets();

    uint256 public constant E18 = 1e18;
    uint256 public constant USDG_TO_E18 = 1e12;
    uint256 public constant BPS = 10_000;
    uint256 public constant GLOBAL_UTILIZATION_BPS = 5_000;
    uint256 public constant MARKET_OPEN_INTEREST_BPS = 1_500;
    uint256 public constant MARKET_SKEW_BPS = 1_000;
    uint256 public constant LIQUIDATION_PENALTY_BPS = 500;
    uint256 public constant LIQUIDATOR_REWARD_BPS = 250;
    uint256 public constant MAX_MARKETS = 10;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "TradeQuote(bytes32 marketId,address trader,bool isLong,uint256 notionalUsdg,uint256 executionPriceE18,uint256 feeUsdg,uint256 maxLeverageE18,uint64 oracleSequence,uint64 nonce,uint64 expiry)"
    );
    bytes32 private constant NAME_HASH = keccak256("FloatSheetsClearing");
    bytes32 private constant VERSION_HASH = keccak256("1");

    enum MarketState {
        Unset,
        Active,
        CloseOnly,
        Paused
    }

    struct Market {
        MarketState state;
        uint64 maxLeverageE18;
        uint64 maintenanceMarginBps;
        uint64 maxExecutionDeviationBps;
        uint64 maxOracleConfidenceBps;
        uint128 maxPositionNotionalUsdg;
    }

    struct MarketExposure {
        uint256 longBaseE18;
        uint256 shortBaseE18;
    }

    struct Position {
        int256 sizeE18;
        uint256 entryPriceE18;
        uint256 marginUsdg;
    }

    struct TradeQuote {
        bytes32 marketId;
        address trader;
        bool isLong;
        uint256 notionalUsdg;
        uint256 executionPriceE18;
        uint256 feeUsdg;
        uint256 maxLeverageE18;
        uint64 oracleSequence;
        uint64 nonce;
        uint64 expiry;
    }

    IERC20 public immutable settlementAsset;
    FloatVault public immutable vault;
    IFloatOracle public immutable oracle;
    address public owner;
    address public quoteSigner;
    address public feeRecipient;
    uint64 public oracleMaxAgeSeconds;
    uint256 private entered;
    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => MarketExposure) public marketExposure;
    mapping(address => mapping(bytes32 => Position)) private positions;
    mapping(address => mapping(uint64 => bool)) public quoteUsed;
    bytes32[] private marketIds;
    mapping(bytes32 => bool) private registeredMarket;

    event MarginDeposited(address indexed trader, bytes32 indexed marketId, uint256 assets);
    event MarginWithdrawn(address indexed trader, bytes32 indexed marketId, uint256 assets);
    event TradeExecuted(
        address indexed trader,
        bytes32 indexed marketId,
        int256 sizeDeltaE18,
        uint256 executionPriceE18,
        uint256 feeUsdg
    );
    event PositionLiquidated(
        address indexed trader,
        bytes32 indexed marketId,
        uint256 priceE18,
        int256 pnlUsdg,
        uint256 penaltyUsdg,
        address liquidator
    );
    event MarketUpdated(bytes32 indexed marketId, MarketState state);
    event QuoteSignerUpdated(address indexed signer);
    event FeeRecipientUpdated(address indexed recipient);
    event OracleMaxAgeUpdated(uint64 age);

    constructor(
        address initialOwner,
        address usdg,
        address vaultAddress,
        address oracleAddress,
        address initialQuoteSigner,
        address initialFeeRecipient,
        uint64 maxOracleAgeSeconds
    ) {
        if (
            initialOwner == address(0) || usdg == address(0) || vaultAddress == address(0)
                || oracleAddress == address(0) || initialQuoteSigner == address(0) || initialFeeRecipient == address(0)
                || maxOracleAgeSeconds == 0
        ) revert ZeroAddress();
        if (address(FloatVault(vaultAddress).asset()) != usdg) revert ZeroAddress();
        owner = initialOwner;
        settlementAsset = IERC20(usdg);
        vault = FloatVault(vaultAddress);
        oracle = IFloatOracle(oracleAddress);
        quoteSigner = initialQuoteSigner;
        feeRecipient = initialFeeRecipient;
        oracleMaxAgeSeconds = maxOracleAgeSeconds;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }
    modifier nonReentrant() {
        if (entered == 1) revert Reentrant();
        entered = 1;
        _;
        entered = 0;
    }

    function setMarket(bytes32 marketId, Market calldata market) external onlyOwner {
        if (
            market.state == MarketState.Unset || market.maxLeverageE18 < E18 || market.maintenanceMarginBps == 0
                || market.maintenanceMarginBps >= BPS || market.maxExecutionDeviationBps > BPS
                || market.maxOracleConfidenceBps > BPS || market.maxPositionNotionalUsdg == 0
        ) revert ZeroAmount();
        if (!registeredMarket[marketId]) {
            if (marketIds.length == MAX_MARKETS) revert TooManyMarkets();
            registeredMarket[marketId] = true;
            marketIds.push(marketId);
        }
        markets[marketId] = market;
        emit MarketUpdated(marketId, market.state);
    }

    function setQuoteSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        quoteSigner = signer;
        emit QuoteSignerUpdated(signer);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    function setOracleMaxAgeSeconds(uint64 age) external onlyOwner {
        if (age == 0) revert ZeroAmount();
        oracleMaxAgeSeconds = age;
        emit OracleMaxAgeUpdated(age);
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    function marketIdAt(uint256 index) external view returns (bytes32) {
        return marketIds[index];
    }

    function getPosition(address trader, bytes32 marketId) external view returns (Position memory) {
        return positions[trader][marketId];
    }

    /// @notice LP assets available for withdrawal after reserving 100% of gross OI at current oracle prices.
    function availableLiquidity() public view returns (uint256) {
        uint256 assets = vault.totalAssets();
        uint256 reserve;
        for (uint256 i; i < marketIds.length; ++i) {
            bytes32 marketId = marketIds[i];
            MarketExposure memory exposure = marketExposure[marketId];
            uint256 price = _oraclePrice(marketId, markets[marketId]).priceE18;
            reserve += _notionalUsdg(int256(exposure.longBaseE18), price)
            + _notionalUsdg(int256(exposure.shortBaseE18), price);
        }
        return reserve >= assets ? 0 : assets - reserve;
    }

    function depositMargin(bytes32 marketId, uint256 assets) external nonReentrant {
        if (markets[marketId].state != MarketState.Active) revert MarketNotActive();
        if (assets == 0) revert ZeroAmount();
        positions[msg.sender][marketId].marginUsdg += assets;
        _safeTransferFrom(msg.sender, address(this), assets);
        emit MarginDeposited(msg.sender, marketId, assets);
    }

    function withdrawMargin(bytes32 marketId, uint256 assets) external nonReentrant {
        Market memory market = markets[marketId];
        Position storage position = positions[msg.sender][marketId];
        if (market.state == MarketState.Unset) revert MarketNotActive();
        if (assets == 0 || assets > position.marginUsdg) revert InsufficientMargin();
        if (market.state == MarketState.Paused && position.sizeE18 != 0) revert MarketPaused();
        position.marginUsdg -= assets;
        if (position.sizeE18 != 0) _requireInitialMargin(position, _currentPrice(marketId, market), market);
        _safeTransfer(msg.sender, assets);
        emit MarginWithdrawn(msg.sender, marketId, assets);
    }

    function execute(TradeQuote calldata quote, bytes calldata signature) external nonReentrant {
        Market memory market = markets[quote.marketId];
        if (market.state == MarketState.Unset || market.state == MarketState.Paused) revert MarketPaused();
        if (quote.trader != msg.sender || quote.notionalUsdg == 0 || quote.executionPriceE18 == 0) {
            revert InvalidDirection();
        }
        if (quote.expiry < block.timestamp) revert QuoteExpired();
        if (quoteUsed[msg.sender][quote.nonce]) revert QuoteUsed();
        if (quote.maxLeverageE18 != market.maxLeverageE18 || _recover(_quoteDigest(quote), signature) != quoteSigner) {
            revert InvalidQuoteSignature();
        }
        IFloatOracle.Price memory oraclePrice = _oraclePrice(quote.marketId, market);
        if (oraclePrice.sequence != quote.oracleSequence) revert OracleSequenceMismatch();
        uint256 deviation = quote.executionPriceE18 > oraclePrice.priceE18
            ? (quote.executionPriceE18 - oraclePrice.priceE18) * BPS / oraclePrice.priceE18
            : (oraclePrice.priceE18 - quote.executionPriceE18) * BPS / oraclePrice.priceE18;
        if (deviation > market.maxExecutionDeviationBps) revert ExecutionPriceOutOfBounds();
        uint256 baseDelta = quote.notionalUsdg * USDG_TO_E18 * E18 / quote.executionPriceE18;
        if (baseDelta > uint256(type(int256).max)) revert PositionLimitExceeded();
        int256 signedDelta = quote.isLong ? int256(baseDelta) : -int256(baseDelta);
        Position storage position = positions[msg.sender][quote.marketId];
        int256 nextSize = position.sizeE18 + signedDelta;
        if (market.state == MarketState.CloseOnly && !_isRiskReducing(position.sizeE18, signedDelta)) {
            revert MarketNotActive();
        }
        quoteUsed[msg.sender][quote.nonce] = true;
        _updateExposure(quote.marketId, position.sizeE18, nextSize);
        _applyTrade(position, signedDelta, quote.executionPriceE18);
        if (quote.feeUsdg > position.marginUsdg) revert InsufficientMargin();
        position.marginUsdg -= quote.feeUsdg;
        _safeTransfer(feeRecipient, quote.feeUsdg);
        uint256 notional = _notionalUsdg(position.sizeE18, quote.executionPriceE18);
        if (notional > market.maxPositionNotionalUsdg) revert PositionLimitExceeded();
        _enforceExposureLimits(quote.marketId, quote.executionPriceE18);
        _requireInitialMargin(position, quote.executionPriceE18, market);
        emit TradeExecuted(msg.sender, quote.marketId, signedDelta, quote.executionPriceE18, quote.feeUsdg);
    }

    function liquidate(address trader, bytes32 marketId) external nonReentrant {
        Market memory market = markets[marketId];
        Position storage position = positions[trader][marketId];
        if (position.sizeE18 == 0) revert PositionNotLiquidatable();
        uint256 price = _currentPrice(marketId, market);
        if (_meetsMaintenanceMargin(position, price, market)) revert PositionNotLiquidatable();
        int256 pnl = _pnlUsdg(position.sizeE18, position.entryPriceE18, price);
        _updateExposure(marketId, position.sizeE18, 0);
        uint256 penalty = _settleMargin(trader, marketId, position, pnl, msg.sender);
        emit PositionLiquidated(trader, marketId, price, pnl, penalty, msg.sender);
    }

    function _updateExposure(bytes32 marketId, int256 previousSize, int256 nextSize) private {
        MarketExposure storage exposure = marketExposure[marketId];
        if (previousSize > 0) exposure.longBaseE18 -= uint256(previousSize);
        else if (previousSize < 0) exposure.shortBaseE18 -= uint256(-previousSize);
        if (nextSize > 0) exposure.longBaseE18 += uint256(nextSize);
        else if (nextSize < 0) exposure.shortBaseE18 += uint256(-nextSize);
    }

    function _enforceExposureLimits(bytes32 tradedMarketId, uint256 executionPrice) private view {
        uint256 assets = vault.totalAssets();
        uint256 globalOi;
        for (uint256 i; i < marketIds.length; ++i) {
            bytes32 marketId = marketIds[i];
            MarketExposure memory exposure = marketExposure[marketId];
            uint256 price =
                marketId == tradedMarketId ? executionPrice : _oraclePrice(marketId, markets[marketId]).priceE18;
            uint256 longOi = _notionalUsdg(int256(exposure.longBaseE18), price);
            uint256 shortOi = _notionalUsdg(int256(exposure.shortBaseE18), price);
            uint256 marketOi = longOi + shortOi;
            if (marketOi > assets * MARKET_OPEN_INTEREST_BPS / BPS) revert OpenInterestLimitExceeded();
            uint256 skew = longOi > shortOi ? longOi - shortOi : shortOi - longOi;
            if (skew > assets * MARKET_SKEW_BPS / BPS) revert SkewLimitExceeded();
            globalOi += marketOi;
        }
        if (globalOi > assets * GLOBAL_UTILIZATION_BPS / BPS) revert UtilizationLimitExceeded();
    }

    function _isRiskReducing(int256 size, int256 delta) private pure returns (bool) {
        return size != 0 && ((size > 0 && delta < 0) || (size < 0 && delta > 0)) && _abs(delta) <= _abs(size);
    }

    function _applyTrade(Position storage p, int256 delta, uint256 price) private {
        int256 oldSize = p.sizeE18;
        if (oldSize == 0 || (oldSize > 0) == (delta > 0)) {
            uint256 oldAbs = _abs(oldSize);
            uint256 deltaAbs = _abs(delta);
            p.entryPriceE18 = (oldAbs * p.entryPriceE18 + deltaAbs * price) / (oldAbs + deltaAbs);
            p.sizeE18 = oldSize + delta;
            return;
        }
        uint256 closed = _abs(oldSize) < _abs(delta) ? _abs(oldSize) : _abs(delta);
        int256 pnl = _pnlUsdg(oldSize > 0 ? int256(closed) : -int256(closed), p.entryPriceE18, price);
        _applyPnl(p, pnl);
        p.sizeE18 = oldSize + delta;
        if (p.sizeE18 == 0) p.entryPriceE18 = 0;
        else if ((p.sizeE18 > 0) != (oldSize > 0)) p.entryPriceE18 = price;
    }

    function _applyPnl(Position storage p, int256 pnl) private {
        if (pnl >= 0) {
            uint256 profit = uint256(pnl);
            vault.payout(address(this), profit);
            p.marginUsdg += profit;
        } else {
            uint256 loss = uint256(-pnl);
            if (loss > p.marginUsdg) revert InsufficientMargin();
            p.marginUsdg -= loss;
            _safeApprove(address(vault), loss);
            vault.collect(loss);
        }
    }

    function _settleMargin(address trader, bytes32 marketId, Position storage p, int256 pnl, address liquidator)
        private
        returns (uint256 penalty)
    {
        if (pnl >= 0) {
            uint256 profit = uint256(pnl);
            vault.payout(address(this), profit);
            p.marginUsdg += profit;
        } else {
            uint256 loss = uint256(-pnl);
            uint256 collected = loss > p.marginUsdg ? p.marginUsdg : loss;
            if (collected != 0) {
                _safeApprove(address(vault), collected);
                vault.collect(collected);
            }
            p.marginUsdg -= collected;
        }
        penalty = p.marginUsdg * LIQUIDATION_PENALTY_BPS / BPS;
        uint256 liquidatorReward = p.marginUsdg * LIQUIDATOR_REWARD_BPS / BPS;
        if (liquidatorReward != 0) _safeTransfer(liquidator, liquidatorReward);
        uint256 vaultPenalty = penalty - liquidatorReward;
        if (vaultPenalty != 0) {
            _safeApprove(address(vault), vaultPenalty);
            vault.collect(vaultPenalty);
        }
        uint256 returned = p.marginUsdg - penalty;
        delete positions[trader][marketId];
        if (returned != 0) _safeTransfer(trader, returned);
    }

    function _requireInitialMargin(Position storage p, uint256 price, Market memory m) private view {
        if (!_meetsInitialMargin(p, price, m)) revert InsufficientMargin();
    }

    function _meetsInitialMargin(Position storage p, uint256 price, Market memory m) private view returns (bool) {
        return _equityUsdg(p, price) >= _notionalUsdg(p.sizeE18, price) * E18 / m.maxLeverageE18;
    }

    function _meetsMaintenanceMargin(Position storage p, uint256 price, Market memory m) private view returns (bool) {
        return _equityUsdg(p, price) >= _notionalUsdg(p.sizeE18, price) * m.maintenanceMarginBps / BPS;
    }

    function _equityUsdg(Position storage p, uint256 price) private view returns (uint256) {
        if (p.sizeE18 == 0) return p.marginUsdg;
        int256 equity = int256(p.marginUsdg) + _pnlUsdg(p.sizeE18, p.entryPriceE18, price);
        return equity < 0 ? 0 : uint256(equity);
    }

    function _currentPrice(bytes32 marketId, Market memory market) private view returns (uint256) {
        return _oraclePrice(marketId, market).priceE18;
    }

    function _oraclePrice(bytes32 marketId, Market memory market)
        private
        view
        returns (IFloatOracle.Price memory price)
    {
        price = oracle.getPrice(marketId);
        if (price.priceE18 == 0 || block.timestamp > uint256(price.timestamp) + oracleMaxAgeSeconds) {
            revert StaleOraclePrice();
        }
        if (price.confidenceBps > market.maxOracleConfidenceBps) revert OracleConfidenceTooLow();
    }

    function _pnlUsdg(int256 size, uint256 entry, uint256 price) private pure returns (int256) {
        int256 priceDelta = price >= entry ? int256(price - entry) : -int256(entry - price);
        return size * priceDelta / int256(E18) / int256(USDG_TO_E18);
    }

    function _notionalUsdg(int256 size, uint256 price) private pure returns (uint256) {
        return _abs(size) * price / E18 / USDG_TO_E18;
    }

    function _abs(int256 value) private pure returns (uint256) {
        return uint256(value >= 0 ? value : -value);
    }

    function _quoteDigest(TradeQuote calldata q) private view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator(),
                keccak256(
                    abi.encode(
                        QUOTE_TYPEHASH,
                        q.marketId,
                        q.trader,
                        q.isLong,
                        q.notionalUsdg,
                        q.executionPriceE18,
                        q.feeUsdg,
                        q.maxLeverageE18,
                        q.oracleSequence,
                        q.nonce,
                        q.expiry
                    )
                )
            )
        );
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28 || uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) {
            return address(0);
        }
        return ecrecover(digest, v, r, s);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(settlementAsset).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(settlementAsset).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeApprove(address spender, uint256 amount) private {
        (bool resetOk, bytes memory resetData) =
            address(settlementAsset).call(abi.encodeCall(IERC20.approve, (spender, 0)));
        if (!resetOk || (resetData.length != 0 && !abi.decode(resetData, (bool)))) revert TransferFailed();
        (bool ok, bytes memory data) = address(settlementAsset).call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
