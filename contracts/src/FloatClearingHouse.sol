// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20, FloatVault} from "./FloatVault.sol";

interface IFloatOracle {
    struct Price {
        uint256 priceE18;
        uint256 spotPriceE18;
        uint256 confidenceBps;
        uint256 spotTwapDeviationBps;
        uint64 timestamp;
        uint64 sequence;
        bool circuitBroken;
    }
    function getPrice(bytes32 marketId) external view returns (Price memory);
}

interface IFloatVaultPayout {
    function payout(address receiver, uint256 assets) external returns (uint256 paid);
    function claimPayout(address receiver, uint256 assets) external returns (uint256 paid);
}

interface IFloatVaultInsurance {
    function fundInsuranceFromClearingHouse(uint256 assets) external;
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
    error InvalidRiskParameters();
    error FeeTooHigh();
    error NothingToClaim();
    error BadDebtOutstanding();
    error InvalidBadDebtAmount();

    uint256 public constant E18 = 1e18;
    uint256 public constant USDG_TO_E18 = 1e12;
    uint256 public constant BPS = 10_000;
    uint256 public constant GLOBAL_UTILIZATION_BPS = 5_000;
    uint256 public constant MARKET_STRESS_MOVE_BPS = 2_500;
    uint256 public constant MAX_GLOBAL_STRESS_RESERVE_BPS = 5_000;
    uint256 public constant BASE_BORROW_FEE_BPS_PER_HOUR = 1;
    uint256 public constant MAX_SKEW_BORROW_FEE_BPS_PER_HOUR = 9;
    uint256 public constant MARKET_OPEN_INTEREST_BPS = 1_500;
    uint256 public constant MARKET_SKEW_BPS = 1_000;
    uint256 public constant LIQUIDATION_PENALTY_BPS = 500;
    uint256 public constant LIQUIDATOR_REWARD_BPS = 250;
    uint256 public constant MIN_LIQUIDATOR_REWARD_USDG = 1e6;
    uint256 public constant MIN_LIQUIDATOR_REWARD_NOTIONAL_BPS = 10;
    uint256 public constant MAX_TRADE_FEE_BPS = 100;
    uint256 public constant MAX_MARKETS = 10;
    /// @notice Positions must be closed or permissionlessly settled within this period.
    uint256 public constant MAX_POSITION_DURATION = 7 days;
    uint256 private constant MAX_INT256 = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "TradeQuote(bytes32 marketId,address trader,int256 sizeDeltaE18,uint256 executionPriceE18,uint256 feeUsdg,uint256 maxLeverageE18,uint64 oracleSequence,uint64 nonce,uint64 expiry)"
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

    struct MarketEntryValue {
        uint256 longEntryValueE18;
        uint256 shortEntryValueE18;
    }

    struct Position {
        int256 sizeE18;
        uint256 entryPriceE18;
        uint256 marginUsdg;
        uint64 openedAt;
    }

    struct TradeQuote {
        bytes32 marketId;
        address trader;
        int256 sizeDeltaE18;
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
    uint256 public activePositionCount;
    uint256 public badDebtUsdg;
    uint256 public totalOpenPositionMarginUsdg;
    uint256 private entered;
    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => MarketExposure) public marketExposure;
    mapping(bytes32 => MarketEntryValue) public marketEntryValue;
    mapping(address => mapping(bytes32 => Position)) private positions;
    mapping(address => mapping(bytes32 => uint64)) public lastBorrowAccrualAt;
    mapping(address => mapping(uint64 => bool)) public quoteUsed;
    mapping(address => uint64) public minimumValidNonce;
    mapping(address => uint256) public claimableBalance;
    mapping(address => uint256) public pendingPayout;
    mapping(address => uint256) public deferredClaim;
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
    event MarketUpdated(
        bytes32 indexed marketId,
        MarketState state,
        uint64 maxLeverageE18,
        uint64 maintenanceMarginBps,
        uint64 maxExecutionDeviationBps,
        uint64 maxOracleConfidenceBps,
        uint128 maxPositionNotionalUsdg
    );
    event MarketDeregistered(bytes32 indexed marketId);
    event QuoteCancelled(address indexed trader, uint64 indexed nonce);
    event QuotesCancelledBefore(address indexed trader, uint64 indexed minimumNonce);
    event ClaimableCredited(address indexed account, uint256 assets);
    event Claimed(address indexed account, address indexed receiver, uint256 assets);
    event QuoteSignerUpdated(address indexed signer);
    event FeeRecipientUpdated(address indexed recipient);
    event OracleMaxAgeUpdated(uint64 age);
    event PositionExpired(address indexed trader, bytes32 indexed marketId, uint64 openedAt);
    event BadDebtRecorded(address indexed trader, uint256 amountUsdg);
    event BadDebtCovered(address indexed payer, uint256 amountUsdg, uint256 remainingUsdg);
    event DeferredClaimAdded(address indexed account, uint256 assets);
    event DeferredClaimPaid(address indexed account, address indexed receiver, uint256 assets);
    event BorrowFeeCharged(address indexed trader, bytes32 indexed marketId, uint256 assets, uint256 rateBpsPerHour);

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
        ) revert InvalidRiskParameters();
        if ((E18 * BPS) / market.maxLeverageE18 <= market.maintenanceMarginBps) {
            revert InvalidRiskParameters();
        }
        if (!registeredMarket[marketId]) {
            if (marketIds.length == MAX_MARKETS) revert TooManyMarkets();
            registeredMarket[marketId] = true;
            marketIds.push(marketId);
        }
        markets[marketId] = market;
        emit MarketUpdated(
            marketId,
            market.state,
            market.maxLeverageE18,
            market.maintenanceMarginBps,
            market.maxExecutionDeviationBps,
            market.maxOracleConfidenceBps,
            market.maxPositionNotionalUsdg
        );
    }

    function deregisterMarket(bytes32 marketId) external onlyOwner {
        MarketExposure memory exposure = marketExposure[marketId];
        if (!registeredMarket[marketId] || exposure.longBaseE18 != 0 || exposure.shortBaseE18 != 0) {
            revert InvalidRiskParameters();
        }
        uint256 length = marketIds.length;
        for (uint256 i; i < length; ++i) {
            if (marketIds[i] == marketId) {
                marketIds[i] = marketIds[length - 1];
                marketIds.pop();
                break;
            }
        }
        delete registeredMarket[marketId];
        delete markets[marketId];
        emit MarketDeregistered(marketId);
    }

    function cancelQuote(uint64 nonce) external {
        quoteUsed[msg.sender][nonce] = true;
        emit QuoteCancelled(msg.sender, nonce);
    }

    function cancelQuotesBefore(uint64 nonce) external {
        if (nonce <= minimumValidNonce[msg.sender]) revert InvalidRiskParameters();
        minimumValidNonce[msg.sender] = nonce;
        emit QuotesCancelledBefore(msg.sender, nonce);
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

    /// @notice LP assets available while preserving the protocol's global utilization ceiling.
    function availableLiquidity() public view returns (uint256) {
        uint256 assets = vault.totalAssets();
        uint256 stressReserve = 0;
        for (uint256 i; i < marketIds.length; ++i) {
            bytes32 marketId = marketIds[i];
            MarketExposure memory exposure = marketExposure[marketId];
            if (exposure.longBaseE18 == 0 && exposure.shortBaseE18 == 0) continue;
            uint256 price = _lastKnownPrice(marketId);
            uint256 netBase = exposure.longBaseE18 > exposure.shortBaseE18
                ? exposure.longBaseE18 - exposure.shortBaseE18
                : exposure.shortBaseE18 - exposure.longBaseE18;
            uint256 netNotional = _notionalUsdgRoundingUp(_asInt256(netBase), price);
            stressReserve += _mulDivRoundingUp(netNotional, MARKET_STRESS_MOVE_BPS, BPS);
        }
        uint256 globalReserveCap = assets * MAX_GLOBAL_STRESS_RESERVE_BPS / BPS;
        if (stressReserve > globalReserveCap) stressReserve = globalReserveCap;
        return stressReserve >= assets ? 0 : assets - stressReserve;
    }

    /// @notice Net trader PnL marked to each market's latest oracle price.
    function unrealizedPnlUsdg() external view returns (int256 pnlUsdg) {
        for (uint256 i; i < marketIds.length; ++i) {
            bytes32 marketId = marketIds[i];
            MarketExposure memory exposure = marketExposure[marketId];
            MarketEntryValue memory entryValue = marketEntryValue[marketId];
            if (exposure.longBaseE18 == 0 && exposure.shortBaseE18 == 0) continue;
            uint256 price = _lastKnownPrice(marketId);
            uint256 longMark = exposure.longBaseE18 * price / E18;
            uint256 shortMark = exposure.shortBaseE18 * price / E18;
            if (longMark >= entryValue.longEntryValueE18) {
                pnlUsdg += _asInt256((longMark - entryValue.longEntryValueE18) / USDG_TO_E18);
            } else {
                pnlUsdg -= _asInt256((entryValue.longEntryValueE18 - longMark) / USDG_TO_E18);
            }
            if (entryValue.shortEntryValueE18 >= shortMark) {
                pnlUsdg += _asInt256((entryValue.shortEntryValueE18 - shortMark) / USDG_TO_E18);
            } else {
                pnlUsdg -= _asInt256((shortMark - entryValue.shortEntryValueE18) / USDG_TO_E18);
            }
        }
    }

    /// @notice Permissionless recapitalization of losses that exceeded isolated trader margin.
    function coverBadDebt(uint256 amountUsdg) external nonReentrant {
        if (amountUsdg == 0 || amountUsdg > badDebtUsdg) revert InvalidBadDebtAmount();
        _safeTransferFrom(msg.sender, address(this), amountUsdg);
        _safeApprove(address(vault), amountUsdg);
        vault.collect(amountUsdg);
        badDebtUsdg -= amountUsdg;
        emit BadDebtCovered(msg.sender, amountUsdg, badDebtUsdg);
    }

    function depositMargin(bytes32 marketId, uint256 assets) external nonReentrant {
        MarketState state = markets[marketId].state;
        if (state != MarketState.Active && state != MarketState.CloseOnly) revert MarketNotActive();
        if (assets == 0) revert ZeroAmount();
        if (assets > MAX_INT256 || positions[msg.sender][marketId].marginUsdg > MAX_INT256 - assets) {
            revert PositionLimitExceeded();
        }
        positions[msg.sender][marketId].marginUsdg += assets;
        if (positions[msg.sender][marketId].sizeE18 != 0) totalOpenPositionMarginUsdg += assets;
        _safeTransferFrom(msg.sender, address(this), assets);
        emit MarginDeposited(msg.sender, marketId, assets);
    }

    function withdrawMargin(bytes32 marketId, uint256 assets) external nonReentrant {
        Market memory market = markets[marketId];
        Position storage position = positions[msg.sender][marketId];
        // Deregistration is permitted only after exposure reaches zero. Keep
        // unused margin withdrawable even after the market entry is removed.
        if (market.state == MarketState.Unset && position.sizeE18 != 0) revert MarketNotActive();
        if (assets == 0 || assets > position.marginUsdg) revert InsufficientMargin();
        if (market.state == MarketState.Paused && position.sizeE18 != 0) revert MarketPaused();
        position.marginUsdg -= assets;
        if (position.sizeE18 != 0) totalOpenPositionMarginUsdg -= assets;
        if (position.sizeE18 != 0) _requireInitialMargin(position, _currentPrice(marketId, market), market);
        uint256 deferred = assets < pendingPayout[msg.sender] ? assets : pendingPayout[msg.sender];
        if (deferred != 0) {
            pendingPayout[msg.sender] -= deferred;
            deferredClaim[msg.sender] += deferred;
            emit DeferredClaimAdded(msg.sender, deferred);
        }
        uint256 payableNow = assets - deferred;
        if (payableNow != 0) _safeTransfer(msg.sender, payableNow);
        emit MarginWithdrawn(msg.sender, marketId, assets);
    }

    function execute(TradeQuote calldata quote, bytes calldata signature) external nonReentrant {
        Market memory market = markets[quote.marketId];
        if (market.state == MarketState.Unset) revert MarketNotActive();
        if (quote.trader != msg.sender || quote.sizeDeltaE18 == 0 || quote.executionPriceE18 == 0) {
            revert InvalidDirection();
        }
        if (quote.expiry < block.timestamp) revert QuoteExpired();
        if (quote.nonce < minimumValidNonce[msg.sender] || quoteUsed[msg.sender][quote.nonce]) revert QuoteUsed();
        if (quote.maxLeverageE18 != market.maxLeverageE18 || _recover(_quoteDigest(quote), signature) != quoteSigner) {
            revert InvalidQuoteSignature();
        }
        IFloatOracle.Price memory oraclePrice = _oraclePrice(quote.marketId, market);
        if (oraclePrice.sequence != quote.oracleSequence) revert OracleSequenceMismatch();
        uint256 deviation = quote.executionPriceE18 > oraclePrice.priceE18
            ? (quote.executionPriceE18 - oraclePrice.priceE18) * BPS / oraclePrice.priceE18
            : (oraclePrice.priceE18 - quote.executionPriceE18) * BPS / oraclePrice.priceE18;
        if (deviation > market.maxExecutionDeviationBps) revert ExecutionPriceOutOfBounds();
        Position storage position = positions[msg.sender][quote.marketId];
        int256 nextSize = position.sizeE18 + quote.sizeDeltaE18;
        bool riskReducing = _isRiskReducing(position.sizeE18, quote.sizeDeltaE18);
        if (!riskReducing && badDebtUsdg != 0) revert BadDebtOutstanding();
        if ((market.state == MarketState.CloseOnly || oraclePrice.circuitBroken) && !riskReducing) {
            revert MarketNotActive();
        }
        if (market.state == MarketState.Paused && !riskReducing) {
            revert MarketPaused();
        }
        uint256 tradedNotional = _notionalUsdgRoundingUp(quote.sizeDeltaE18, quote.executionPriceE18);
        if (quote.feeUsdg > tradedNotional * MAX_TRADE_FEE_BPS / BPS) revert FeeTooHigh();
        quoteUsed[msg.sender][quote.nonce] = true;
        _applyExecution(quote, market, position, nextSize, riskReducing);
    }

    function _applyExecution(
        TradeQuote calldata quote,
        Market memory market,
        Position storage position,
        int256 nextSize,
        bool riskReducing
    ) private {
        int256 previousSize = position.sizeE18;
        uint256 marginBefore = position.marginUsdg;
        _applyPositionTrade(quote, position, nextSize);
        uint256 chargedFee = quote.feeUsdg;
        // A reduction must never be blocked solely because realized losses
        // consumed the remaining margin before the fee is charged. Treat the
        // signed fee as a maximum and collect only what remains.
        if (chargedFee > position.marginUsdg) {
            if (!riskReducing) revert InsufficientMargin();
            chargedFee = position.marginUsdg;
        }
        position.marginUsdg -= chargedFee;
        if (chargedFee != 0) _safeTransfer(feeRecipient, chargedFee);
        if (previousSize != 0) totalOpenPositionMarginUsdg -= marginBefore;
        if (position.sizeE18 != 0) totalOpenPositionMarginUsdg += position.marginUsdg;
        if (!riskReducing) {
            uint256 notional = _notionalUsdg(position.sizeE18, quote.executionPriceE18);
            if (notional > market.maxPositionNotionalUsdg) revert PositionLimitExceeded();
            _enforceExposureLimits(quote.marketId, quote.executionPriceE18);
            _requireInitialMargin(position, quote.executionPriceE18, market);
        }
        emit TradeExecuted(msg.sender, quote.marketId, quote.sizeDeltaE18, quote.executionPriceE18, chargedFee);
    }

    function _applyPositionTrade(TradeQuote calldata quote, Position storage position, int256 nextSize) private {
        int256 previousSize = position.sizeE18;
        uint256 previousEntry = position.entryPriceE18;
        _accrueBorrowFee(msg.sender, quote.marketId, position);
        _applyTrade(position, quote.sizeDeltaE18, quote.executionPriceE18, nextSize == 0, msg.sender);
        _updateExposure(quote.marketId, previousSize, previousEntry, position.sizeE18, position.entryPriceE18);
        if (previousSize == 0 && nextSize != 0) {
            ++activePositionCount;
            position.openedAt = uint64(block.timestamp);
        } else if (previousSize != 0 && nextSize == 0) {
            --activePositionCount;
            position.openedAt = 0;
        } else if (previousSize != 0 && nextSize != 0 && ((previousSize > 0) != (nextSize > 0))) {
            position.openedAt = uint64(block.timestamp);
        }
    }

    function liquidate(address trader, bytes32 marketId) external nonReentrant {
        Position storage position = positions[trader][marketId];
        if (position.sizeE18 == 0) revert PositionNotLiquidatable();
        bool expired = block.timestamp >= uint256(position.openedAt) + MAX_POSITION_DURATION;
        uint256 price = _currentPrice(marketId, markets[marketId]);
        if (!expired && _meetsMaintenanceMargin(position, price, markets[marketId])) revert PositionNotLiquidatable();
        uint256 marginBeforeAccrual = position.marginUsdg;
        _accrueBorrowFee(trader, marketId, position);
        totalOpenPositionMarginUsdg -= marginBeforeAccrual;
        totalOpenPositionMarginUsdg += position.marginUsdg;
        uint256 marginAtSettlement = position.marginUsdg;
        uint64 openedAt = _settlePosition(trader, marketId, price, expired);
        totalOpenPositionMarginUsdg -= marginAtSettlement;
        if (expired) emit PositionExpired(trader, marketId, openedAt);
    }

    function _settlePosition(address trader, bytes32 marketId, uint256 price, bool expired)
        private
        returns (uint64 openedAt)
    {
        Position storage position = positions[trader][marketId];
        uint256 positionNotional = _notionalUsdgRoundingUp(position.sizeE18, price);
        int256 pnl = _pnlUsdg(position.sizeE18, position.entryPriceE18, price);
        openedAt = position.openedAt;
        _updateExposure(marketId, position.sizeE18, position.entryPriceE18, 0, 0);
        (uint256 penalty, uint256 liquidatorReward, uint256 returned) =
            _settleMargin(position, pnl, positionNotional, expired, trader);
        delete positions[trader][marketId];
        --activePositionCount;
        _creditClaimable(msg.sender, liquidatorReward);
        _creditClaimable(trader, returned);
        emit PositionLiquidated(trader, marketId, price, pnl, penalty, msg.sender);
    }

    function claim(address receiver) external nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert ZeroAddress();
        assets = claimableBalance[msg.sender];
        if (assets == 0) revert NothingToClaim();
        claimableBalance[msg.sender] = 0;
        uint256 deferred = assets < pendingPayout[msg.sender] ? assets : pendingPayout[msg.sender];
        if (deferred != 0) {
            pendingPayout[msg.sender] -= deferred;
            deferredClaim[msg.sender] += deferred;
            emit DeferredClaimAdded(msg.sender, deferred);
        }
        uint256 payableNow = assets - deferred;
        if (payableNow != 0) _safeTransfer(receiver, payableNow);
        emit Claimed(msg.sender, receiver, assets);
    }

    /// @notice Withdraws any part of a user's payout that the vault previously deferred.
    function claimDeferred(address receiver) external nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert ZeroAddress();
        uint256 requested = deferredClaim[msg.sender];
        if (requested == 0) revert NothingToClaim();
        assets = IFloatVaultPayout(address(vault)).claimPayout(receiver, requested);
        deferredClaim[msg.sender] = requested - assets;
        if (assets != 0) emit DeferredClaimPaid(msg.sender, receiver, assets);
    }

    function _updateExposure(bytes32 marketId, int256 previousSize, uint256 previousEntry, int256 nextSize, uint256 nextEntry) private {
        MarketExposure storage exposure = marketExposure[marketId];
        MarketEntryValue storage entryValue = marketEntryValue[marketId];
        if (previousSize > 0) {
            uint256 oldBase = _abs(previousSize);
            exposure.longBaseE18 -= oldBase;
            entryValue.longEntryValueE18 -= oldBase * previousEntry / E18;
        } else if (previousSize < 0) {
            uint256 oldBase = _abs(previousSize);
            exposure.shortBaseE18 -= oldBase;
            entryValue.shortEntryValueE18 -= oldBase * previousEntry / E18;
        }
        if (nextSize > 0) {
            uint256 newBase = _abs(nextSize);
            exposure.longBaseE18 += newBase;
            entryValue.longEntryValueE18 += newBase * nextEntry / E18;
        } else if (nextSize < 0) {
            uint256 newBase = _abs(nextSize);
            exposure.shortBaseE18 += newBase;
            entryValue.shortEntryValueE18 += newBase * nextEntry / E18;
        }
    }

    function _accrueBorrowFee(address trader, bytes32 marketId, Position storage position) private {
        if (position.sizeE18 == 0) {
            lastBorrowAccrualAt[trader][marketId] = uint64(block.timestamp);
            return;
        }
        uint64 last = lastBorrowAccrualAt[trader][marketId];
        lastBorrowAccrualAt[trader][marketId] = uint64(block.timestamp);
        if (last == 0 || block.timestamp <= last) return;
        MarketExposure memory exposure = marketExposure[marketId];
        uint256 longNotional = _notionalUsdgRoundingUp(_asInt256(exposure.longBaseE18), _lastKnownPrice(marketId));
        uint256 shortNotional = _notionalUsdgRoundingUp(_asInt256(exposure.shortBaseE18), _lastKnownPrice(marketId));
        uint256 gross = longNotional + shortNotional;
        if (gross == 0 || longNotional == shortNotional) return;
        bool longCrowded = longNotional > shortNotional;
        if ((position.sizeE18 > 0) != longCrowded) return;
        uint256 skew = longNotional > shortNotional ? longNotional - shortNotional : shortNotional - longNotional;
        uint256 rate = BASE_BORROW_FEE_BPS_PER_HOUR
            + MAX_SKEW_BORROW_FEE_BPS_PER_HOUR * skew / gross;
        uint256 notional = _notionalUsdgRoundingUp(position.sizeE18, _lastKnownPrice(marketId));
        uint256 fee = notional * rate * (block.timestamp - last) / BPS / 1 hours;
        if (fee > position.marginUsdg) fee = position.marginUsdg;
        if (fee != 0) {
            position.marginUsdg -= fee;
            _safeApprove(address(vault), fee);
            IFloatVaultInsurance(address(vault)).fundInsuranceFromClearingHouse(fee);
            emit BorrowFeeCharged(trader, marketId, fee, rate);
        }
    }

    function _enforceExposureLimits(bytes32 tradedMarketId, uint256 executionPrice) private view {
        uint256 assets = vault.totalAssets();
        uint256 globalOi = 0;
        for (uint256 i; i < marketIds.length; ++i) {
            bytes32 marketId = marketIds[i];
            MarketExposure memory exposure = marketExposure[marketId];
            if (exposure.longBaseE18 == 0 && exposure.shortBaseE18 == 0) continue;
            uint256 price = marketId == tradedMarketId ? executionPrice : _lastKnownPrice(marketId);
            uint256 longOi = _notionalUsdgRoundingUp(_asInt256(exposure.longBaseE18), price);
            uint256 shortOi = _notionalUsdgRoundingUp(_asInt256(exposure.shortBaseE18), price);
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

    function _applyTrade(Position storage p, int256 delta, uint256 price, bool allowBadDebt, address trader) private {
        int256 oldSize = p.sizeE18;
        if (oldSize == 0 || (oldSize > 0) == (delta > 0)) {
            uint256 oldAbs = _abs(oldSize);
            uint256 deltaAbs = _abs(delta);
            p.entryPriceE18 = (oldAbs * p.entryPriceE18 + deltaAbs * price) / (oldAbs + deltaAbs);
            p.sizeE18 = oldSize + delta;
            return;
        }
        uint256 closed = _abs(oldSize) < _abs(delta) ? _abs(oldSize) : _abs(delta);
        int256 pnl = _pnlUsdg(oldSize > 0 ? _asInt256(closed) : -_asInt256(closed), p.entryPriceE18, price);
        _applyPnl(p, pnl, allowBadDebt, trader);
        p.sizeE18 = oldSize + delta;
        if (p.sizeE18 == 0) p.entryPriceE18 = 0;
        else if ((p.sizeE18 > 0) != (oldSize > 0)) p.entryPriceE18 = price;
    }

    function _applyPnl(Position storage p, int256 pnl, bool allowBadDebt, address trader) private {
        if (pnl >= 0) {
            uint256 profit = _abs(pnl);
            uint256 paid = IFloatVaultPayout(address(vault)).payout(address(this), profit);
            if (paid < profit) pendingPayout[trader] += profit - paid;
            p.marginUsdg += profit;
        } else {
            uint256 loss = _abs(pnl);
            if (loss > p.marginUsdg && !allowBadDebt) revert InsufficientMargin();
            uint256 collected = loss > p.marginUsdg ? p.marginUsdg : loss;
            if (loss > collected) {
                _recordBadDebt(trader, loss - collected);
            }
            p.marginUsdg -= collected;
            if (collected != 0) {
                _safeApprove(address(vault), collected);
                vault.collect(collected);
            }
        }
    }

    function _settleMargin(Position storage p, int256 pnl, uint256 positionNotional, bool expired, address trader)
        private
        returns (uint256 penalty, uint256 liquidatorReward, uint256 returned)
    {
        uint256 lossCollected = 0;
        if (pnl >= 0) {
            uint256 profit = _abs(pnl);
            uint256 paid = IFloatVaultPayout(address(vault)).payout(address(this), profit);
            if (paid < profit) pendingPayout[trader] += profit - paid;
            p.marginUsdg += profit;
        } else {
            uint256 loss = _abs(pnl);
            lossCollected = loss > p.marginUsdg ? p.marginUsdg : loss;
            if (loss > lossCollected) _recordBadDebt(trader, loss - lossCollected);
            p.marginUsdg -= lossCollected;
        }
        if (expired) {
            // Expiry is a scheduled close, not a maintenance liquidation:
            // only pay the keeper from remaining trader margin and do not levy
            // the protocol's liquidation penalty or subsidy it from LP funds.
            uint256 expiryMinimumReward = positionNotional * MIN_LIQUIDATOR_REWARD_NOTIONAL_BPS / BPS;
            if (expiryMinimumReward > MIN_LIQUIDATOR_REWARD_USDG) expiryMinimumReward = MIN_LIQUIDATOR_REWARD_USDG;
            uint256 expiryMarginReward = p.marginUsdg * LIQUIDATOR_REWARD_BPS / BPS;
            liquidatorReward = expiryMarginReward > expiryMinimumReward ? expiryMarginReward : expiryMinimumReward;
            if (liquidatorReward > p.marginUsdg) liquidatorReward = p.marginUsdg;
            penalty = liquidatorReward;
            if (lossCollected != 0) {
                _safeApprove(address(vault), lossCollected);
                vault.collect(lossCollected);
            }
            return (penalty, liquidatorReward, p.marginUsdg - penalty);
        }
        penalty = p.marginUsdg * LIQUIDATION_PENALTY_BPS / BPS;
        uint256 marginFundedReward = p.marginUsdg * LIQUIDATOR_REWARD_BPS / BPS;
        uint256 minimumReward = positionNotional * MIN_LIQUIDATOR_REWARD_NOTIONAL_BPS / BPS;
        if (minimumReward > MIN_LIQUIDATOR_REWARD_USDG) minimumReward = MIN_LIQUIDATOR_REWARD_USDG;
        liquidatorReward = marginFundedReward > minimumReward ? marginFundedReward : minimumReward;
        uint256 vaultPenalty = penalty - marginFundedReward;
        uint256 totalCollection = lossCollected + vaultPenalty;
        if (totalCollection != 0) {
            _safeApprove(address(vault), totalCollection);
            vault.collect(totalCollection);
        }
        uint256 rewardSubsidy = liquidatorReward - marginFundedReward;
        if (rewardSubsidy != 0) {
            uint256 paid = IFloatVaultPayout(address(vault)).payout(address(this), rewardSubsidy);
            if (paid < rewardSubsidy) pendingPayout[msg.sender] += rewardSubsidy - paid;
        }
        returned = p.marginUsdg - penalty;
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
        int256 equity = _asInt256(p.marginUsdg) + _pnlUsdg(p.sizeE18, p.entryPriceE18, price);
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

    function _lastKnownPrice(bytes32 marketId) private view returns (uint256 priceE18) {
        IFloatOracle.Price memory price = oracle.getPrice(marketId);
        if (price.priceE18 == 0) revert StaleOraclePrice();
        return price.priceE18;
    }

    function _pnlUsdg(int256 size, uint256 entry, uint256 price) private pure returns (int256) {
        int256 priceDelta = price >= entry ? _asInt256(price - entry) : -_asInt256(entry - price);
        return size * priceDelta / _asInt256(E18) / _asInt256(USDG_TO_E18);
    }

    function _notionalUsdg(int256 size, uint256 price) private pure returns (uint256) {
        return _abs(size) * price / E18 / USDG_TO_E18;
    }

    function _notionalUsdgRoundingUp(int256 size, uint256 price) private pure returns (uint256) {
        return _mulDivRoundingUp(_abs(size), price, E18 * USDG_TO_E18);
    }

    function _mulDivRoundingUp(uint256 x, uint256 y, uint256 denominator) private pure returns (uint256) {
        uint256 product = x * y;
        return product == 0 ? 0 : (product - 1) / denominator + 1;
    }

    function _creditClaimable(address account, uint256 assets) private {
        if (assets == 0) return;
        claimableBalance[account] += assets;
        emit ClaimableCredited(account, assets);
    }

    function _recordBadDebt(address trader, uint256 amount) private {
        if (amount == 0) return;
        badDebtUsdg += amount;
        emit BadDebtRecorded(trader, amount);
    }

    function _abs(int256 value) private pure returns (uint256) {
        if (value == type(int256).min) revert PositionLimitExceeded();
        return uint256(value >= 0 ? value : -value);
    }

    function _asInt256(uint256 value) private pure returns (int256) {
        if (value > MAX_INT256) revert PositionLimitExceeded();
        return int256(value);
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
                        q.sizeDeltaE18,
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
        if ((v != 27 && v != 28) || uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) {
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
