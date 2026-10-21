// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20, FloatVault} from "../src/FloatVault.sol";
import {FloatOracle} from "../src/FloatOracle.sol";
import {FloatClearingHouse} from "../src/FloatClearingHouse.sol";

interface VmFork {
    function createSelectFork(string calldata rpcUrl) external returns (uint256);
    function envString(string calldata name) external returns (string memory);
    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert(bytes4) external;
    function warp(uint256 timestamp) external;
}

/// @notice Fork tests use the real Robinhood Chain USDG token and a real NVDA/USDG pool balance; no test ERC-20 is used.
contract FloatClearingHouseForkTest {
    VmFork private constant vm = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address private constant NVDA_USDG_POOL = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;
    address private constant TRADER = 0x1111111111111111111111111111111111111111;
    address private constant KEEPER = 0x2222222222222222222222222222222222222222;
    bytes32 private constant MARKET = keccak256("NVDA-PERP");
    uint256 private constant ORACLE_KEY = 0xA11CE;
    uint256 private constant QUOTE_KEY = 0xB0B;
    uint256 private constant E18 = 1e18;
    uint256 private constant USDG_UNIT = 1e6;

    IERC20 private usdg = IERC20(USDG);
    FloatOracle private oracle;
    FloatVault private vault;
    FloatClearingHouse private clearing;
    uint256 private lpShares;

    function setUp() public {
        vm.createSelectFork(vm.envString("RHC_RPC_URL"));
        oracle = new FloatOracle(address(this), vm.addr(ORACLE_KEY));
        vault = new FloatVault(address(this), USDG);
        clearing = new FloatClearingHouse(
            address(this), USDG, address(vault), address(oracle), vm.addr(QUOTE_KEY), address(this), 120
        );
        vault.setClearingHouse(address(clearing));
        oracle.setMarketEnabled(MARKET, true);
        clearing.setMarket(
            MARKET,
            FloatClearingHouse.Market({
                state: FloatClearingHouse.MarketState.Paused,
                maxLeverageE18: uint64(5 * E18),
                maintenanceMarginBps: 1_000,
                maxExecutionDeviationBps: 30,
                maxOracleConfidenceBps: 50,
                maxPositionNotionalUsdg: uint128(150_000 * USDG_UNIT)
            })
        );
        FloatClearingHouse.Market memory activeMarket = clearing.getMarket(MARKET);
        activeMarket.state = FloatClearingHouse.MarketState.Active;
        clearing.setMarket(MARKET, activeMarket);
        vm.warp(block.timestamp + clearing.CONFIG_DELAY());
        clearing.applyMarket(MARKET);
        oracle.applyMarketEnabled(MARKET);
        _publish(1, 228 * E18, 10);

        vm.prank(NVDA_USDG_POOL);
        require(usdg.transfer(address(this), 1_100_000 * USDG_UNIT), "fork USDG transfer");
        usdg.approve(address(vault), type(uint256).max);
        lpShares = vault.deposit(1_000_000 * USDG_UNIT, address(this));
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        vault.settleQueue();
        vault.claimDeposit(vault.queueEpoch());
        vault.startNextQueueEpoch();
        _publish(2, 228 * E18, 10);
        require(usdg.transfer(TRADER, 50_000 * USDG_UNIT), "trader funding");
        vm.prank(TRADER);
        usdg.approve(address(clearing), type(uint256).max);
    }

    function testUsesRealUsdqAndReservesGrossOpenInterest() public {
        _depositTraderMargin(20_000 * USDG_UNIT);
        _execute(_quote(true, 50_000 * USDG_UNIT, 1));

        uint256 available = clearing.availableLiquidity();
        require(available < 988_000 * USDG_UNIT, "stress reserve was not applied");
        require(available > 987_000 * USDG_UNIT, "unexpected reserve");
    }

    function testBlocksLpWithdrawalOfReservedLiquidity() public {
        _depositTraderMargin(20_000 * USDG_UNIT);
        _execute(_quote(true, 50_000 * USDG_UNIT, 1));

        vault.withdraw(lpShares * 99 / 100, address(this));
        vm.warp(block.timestamp + vault.QUEUE_EPOCH_DURATION());
        vm.expectRevert(FloatVault.InsufficientAvailableLiquidity.selector);
        vault.settleQueue();
    }

    function testStressReserveTracksNetExposureWhenLongAndShortExposureOffsets() public {
        _depositTraderMargin(20_000 * USDG_UNIT);
        _execute(_quote(true, 50_000 * USDG_UNIT, 1));
        require(usdg.transfer(KEEPER, 20_000 * USDG_UNIT), "second trader funding");
        vm.prank(KEEPER);
        usdg.approve(address(clearing), type(uint256).max);
        vm.prank(KEEPER);
        clearing.depositMargin(MARKET, 10_000 * USDG_UNIT);
        FloatClearingHouse.TradeQuote memory shortQuote = _quoteFor(KEEPER, false, 25_000 * USDG_UNIT, 2);
        vm.prank(KEEPER);
        clearing.execute(shortQuote, _quoteSignature(shortQuote));

        uint256 available = clearing.availableLiquidity();
        require(available < 994_000 * USDG_UNIT, "net stress reserve was not applied");
        require(available > 993_000 * USDG_UNIT, "unexpected net reserve");
    }

    function testCloseOnlyAllowsReductionButNotRiskIncrease() public {
        _depositTraderMargin(20_000 * USDG_UNIT);
        _execute(_quote(true, 50_000 * USDG_UNIT, 1));
        clearing.setMarket(
            MARKET,
            FloatClearingHouse.Market({
                state: FloatClearingHouse.MarketState.CloseOnly,
                maxLeverageE18: uint64(5 * E18),
                maintenanceMarginBps: 1_000,
                maxExecutionDeviationBps: 30,
                maxOracleConfidenceBps: 50,
                maxPositionNotionalUsdg: uint128(150_000 * USDG_UNIT)
            })
        );

        _execute(_quote(false, 25_000 * USDG_UNIT, 2));
        FloatClearingHouse.TradeQuote memory increase = _quote(true, 5_000 * USDG_UNIT, 3);
        bytes memory signature = _quoteSignature(increase);
        vm.expectRevert(FloatClearingHouse.MarketNotActive.selector);
        vm.prank(TRADER);
        clearing.execute(increase, signature);
    }

    function testPausedAllowsOnlyRiskReduction() public {
        _depositTraderMargin(20_000 * USDG_UNIT);
        _execute(_quote(true, 50_000 * USDG_UNIT, 1));
        clearing.setMarket(
            MARKET,
            FloatClearingHouse.Market({
                state: FloatClearingHouse.MarketState.Paused,
                maxLeverageE18: uint64(5 * E18),
                maintenanceMarginBps: 1_000,
                maxExecutionDeviationBps: 30,
                maxOracleConfidenceBps: 50,
                maxPositionNotionalUsdg: uint128(150_000 * USDG_UNIT)
            })
        );
        _execute(_quote(false, 25_000 * USDG_UNIT, 2));
        FloatClearingHouse.TradeQuote memory increase = _quote(true, 5_000 * USDG_UNIT, 3);
        bytes memory signature = _quoteSignature(increase);
        vm.expectRevert(FloatClearingHouse.MarketPaused.selector);
        vm.prank(TRADER);
        clearing.execute(increase, signature);
    }

    function testFullLiquidationPaysKeeperAndClearsExposure() public {
        _depositTraderMargin(20_000 * USDG_UNIT);
        _execute(_quote(true, 50_000 * USDG_UNIT, 1));
        _publish(3, 190 * E18, 10);
        _publish(4, 160 * E18, 10);
        _publish(5, 140 * E18, 10);
        uint256 keeperBefore = usdg.balanceOf(KEEPER);
        vm.prank(KEEPER);
        clearing.liquidate(TRADER, MARKET);
        FloatClearingHouse.Position memory position = clearing.getPosition(TRADER, MARKET);
        (uint256 longBaseE18, uint256 shortBaseE18) = clearing.marketExposure(MARKET);
        require(position.sizeE18 == 0 && position.marginUsdg == 0, "position not cleared");
        require(longBaseE18 == 0 && shortBaseE18 == 0, "exposure not cleared");
        require(clearing.claimableBalance(KEEPER) > 0, "keeper reward not credited");
        vm.prank(KEEPER);
        clearing.claim(KEEPER);
        require(usdg.balanceOf(KEEPER) > keeperBefore, "keeper not rewarded");
    }

    function testRejectsDirectionalSkewAboveTenPercentOfVaultAssets() public {
        _depositTraderMargin(25_000 * USDG_UNIT);
        _execute(_quote(true, 100_000 * USDG_UNIT, 1));

        FloatClearingHouse.TradeQuote memory increase = _quote(true, 1 * USDG_UNIT, 2);
        vm.expectRevert(FloatClearingHouse.SkewLimitExceeded.selector);
        vm.prank(TRADER);
        clearing.execute(increase, _quoteSignature(increase));
    }

    function testRejectsAnOracleAttestationAboveTheConfiguredConfidenceLimit() public {
        _depositTraderMargin(20_000 * USDG_UNIT);
        uint64 sequence = oracle.getPrice(MARKET).sequence + 1;
        _publish(sequence, 228 * E18, 51);
        FloatClearingHouse.TradeQuote memory quote = _quote(true, 5_000 * USDG_UNIT, 1);
        vm.expectRevert(FloatClearingHouse.OracleConfidenceTooLow.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _quoteSignature(quote));
    }

    function testRejectsStaleOraclePricesAndReplayedQuotes() public {
        _depositTraderMargin(20_000 * USDG_UNIT);
        FloatClearingHouse.TradeQuote memory quote = _quote(true, 5_000 * USDG_UNIT, 1);
        _execute(quote);
        vm.expectRevert(FloatClearingHouse.QuoteUsed.selector);
        vm.prank(TRADER);
        clearing.execute(quote, _quoteSignature(quote));

        vm.warp(block.timestamp + 121);
        FloatClearingHouse.TradeQuote memory freshNonce = _quote(true, 5_000 * USDG_UNIT, 2);
        vm.expectRevert(FloatClearingHouse.StaleOraclePrice.selector);
        vm.prank(TRADER);
        clearing.execute(freshNonce, _quoteSignature(freshNonce));
    }

    function _depositTraderMargin(uint256 amount) private {
        vm.prank(TRADER);
        clearing.depositMargin(MARKET, amount);
    }

    function _execute(FloatClearingHouse.TradeQuote memory quote) private {
        bytes memory signature = _quoteSignature(quote);
        vm.prank(TRADER);
        clearing.execute(quote, signature);
    }

    function _quote(bool isLong, uint256 notional, uint64 nonce)
        private
        view
        returns (FloatClearingHouse.TradeQuote memory)
    {
        return _quoteFor(TRADER, isLong, notional, nonce);
    }

    function _quoteFor(address trader, bool isLong, uint256 notional, uint64 nonce)
        private
        view
        returns (FloatClearingHouse.TradeQuote memory)
    {
        return FloatClearingHouse.TradeQuote({
            marketId: MARKET,
            trader: trader,
            sizeDeltaE18: isLong
                ? int256(notional * 1e12 * E18 / (228 * E18))
                : -int256(notional * 1e12 * E18 / (228 * E18)),
            executionPriceE18: 228 * E18,
            feeUsdg: notional * 6 / 10_000,
            maxLeverageE18: 5 * E18,
            oracleSequence: oracle.getPrice(MARKET).sequence,
            nonce: nonce,
            expiry: uint64(block.timestamp + 60)
        });
    }

    function _publish(uint64 sequence, uint256 price, uint256 confidence) private {
        FloatOracle.PriceAttestation memory attestation = FloatOracle.PriceAttestation(
            MARKET, price, price, confidence, uint64(block.timestamp), sequence, uint64(block.timestamp + 60)
        );
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

    function _quoteSignature(FloatClearingHouse.TradeQuote memory quote) private returns (bytes memory) {
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
