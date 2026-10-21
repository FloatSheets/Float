import { Router, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Address } from "viem";
import type { Hex } from "viem";
import type { Pool } from "pg";

import { contractConfigForVersion, type AppConfig } from "../config";
import { contractVersionFromRequest } from "../contract-version";
import {
  approveUsdG, claimDeferredPayout, claimProtocolBalance, configureMarket, depositMargin, depositVault, enableMarket, liquidate, marketId, withdrawMargin, withdrawVault
} from "../chain/protocol";
import { publishOracle, executeTrade } from "../chain/protocol";
import { requireMasterAdmin } from "../auth/master-admin";
import { signPriceAttestation, signTradeQuote } from "../signing/signer";
import type { PriceAttestation, TradeQuote } from "../signing/types";
import type { RpcTransport } from "../chain/rpc";
import { readBadDebt, readClearingExposure, readClearingMarket, readClearingPosition, readOraclePrice, readPayoutBalances, readVaultAssets } from "../chain/protocol-read";
import type { OraclePublisher } from "../oracle/publisher";
import { safeErrorMessage } from "../safe-error";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^\d+$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const signedInt = z.string().regex(/^-?\d+$/);
const attestation = z.object({ marketId: hex, priceE18: uint, spotPriceE18: uint, confidenceBps: uint, timestamp: uint, sequence: uint, expiry: uint });
const quote = z.object({
  market: z.string().min(1), marketId: hex, trader: address, sizeDeltaE18: signedInt, executionPriceE18: uint,
  feeUsdg: uint, maxLeverageE18: uint, oracleSequence: uint, nonce: uint, expiry: uint
});
const traderQuoteRequest = z.object({
  market: z.string().min(1).max(16), trader: address, isLong: z.boolean(), notionalUsdg: uint
});
const tradeCheckRequest = traderQuoteRequest.extend({ marginUsdg: uint, targetLeverage: uint });
const closeQuoteRequest = z.object({ market: z.string().min(1).max(16), trader: address });
const TRADING_FEE_BPS = 6n;
const MAX_TRADING_FEE_BPS = 100n;
const BPS = 10_000n;
const USDG_TO_E18 = 1_000_000_000_000n;
const E18 = 1_000_000_000_000_000_000n;
const QUOTE_ORACLE_HEADROOM_SECONDS = 5n;
const BPS_MARKET_OPEN_INTEREST_CAP = 1_500n;
const BPS_MARKET_SKEW_CAP = 1_000n;

function bigint(value: string): bigint {
  return BigInt(value);
}

function usdgUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0").slice(0, 6)}`);
}

function usdgDecimal(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

function deviationBps(a: bigint, b: bigint): bigint {
  const delta = a > b ? a - b : b - a;
  return delta * 10_000n / b;
}

function quoteNonce(): bigint {
  return BigInt(`0x${randomBytes(8).toString("hex")}`);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function notionalForSize(sizeDeltaE18: bigint, executionPriceE18: bigint): bigint {
  const numerator = abs(sizeDeltaE18) * executionPriceE18;
  const denominator = E18 * USDG_TO_E18;
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function sizeForNotional(notionalUsdg: bigint, executionPriceE18: bigint, isLong: boolean): bigint {
  const size = notionalUsdg * USDG_TO_E18 * E18 / executionPriceE18;
  return isLong ? size : -size;
}

function ceilingDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

/**
 * A trade quote must not outlive the oracle price it references. The small
 * headroom avoids a quote becoming invalid while it is being propagated into
 * a block at the end of the oracle freshness window.
 */
function boundedQuoteExpiry(
  now: bigint,
  oracleTimestamp: bigint,
  oracleMaxAgeSeconds: number,
  configuredTtlSeconds: number
): bigint {
  const requestedExpiry = now + BigInt(configuredTtlSeconds);
  const oracleExpiry = oracleTimestamp + BigInt(oracleMaxAgeSeconds) - QUOTE_ORACLE_HEADROOM_SECONDS;
  return requestedExpiry < oracleExpiry ? requestedExpiry : oracleExpiry;
}

function protocolError(response: Response, error: unknown): void {
  const message = safeErrorMessage(error);
  // Keep actionable validation messages, but never echo provider exception
  // details (they can contain credential-bearing RPC URLs and request data).
  const providerError = /redacted endpoint|rpc request|http request|request body|socket hang up|fetch failed/i.test(message);
  const safeMessage = providerError ? "Protocol service is temporarily unavailable" : message.slice(0, 240);
  response.status(providerError ? 503 : 400).json({ error: safeMessage || "Invalid protocol request" });
}

export function createProtocolTransactionsRouter(
  config: AppConfig,
  database?: Pool,
  rpc?: RpcTransport,
  oraclePublisher?: Pick<OraclePublisher, "ensureFreshMarket">
): Router {
  const router = Router();
  const versions = {
    meadow: createProtocolTransactionsRouterForConfig(contractConfigForVersion(config, "meadow"), database, rpc, oraclePublisher),
    "legacy-orion": createProtocolTransactionsRouterForConfig(contractConfigForVersion(config, "legacy-orion"), database, rpc, oraclePublisher)
  };
  router.use((request, response, next) => versions[contractVersionFromRequest(request)](request, response, next));
  return router;
}

function createProtocolTransactionsRouterForConfig(
  config: AppConfig,
  database?: Pool,
  rpc?: RpcTransport,
  oraclePublisher?: Pick<OraclePublisher, "ensureFreshMarket">
): Router {
  const router = Router();
  const masterAdmin = requireMasterAdmin(config);

  router.get("/payouts/:account", async (request, response) => {
    try {
      if (!rpc) throw new Error("chain read service is unavailable");
      const account = address.parse(request.params.account) as Address;
      const balances = await readPayoutBalances(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, account);
      response.json({
        claimable_usdg: balances.claimableBalance.toString(),
        deferred_usdg: balances.deferredClaim.toString(),
        pending_usdg: balances.pendingPayout.toString()
      });
    } catch (error) { protocolError(response, error); }
  });

  router.post("/oracle-attestation", masterAdmin, async (request, response) => {
    try {
      const input = attestation.parse(request.body) as Record<string, string>;
      const value: PriceAttestation = {
        marketId: input.marketId as Hex, priceE18: bigint(input.priceE18), spotPriceE18: bigint(input.spotPriceE18), confidenceBps: bigint(input.confidenceBps),
        timestamp: bigint(input.timestamp), sequence: bigint(input.sequence), expiry: bigint(input.expiry)
      };
      const signature = await signPriceAttestation(config.ORACLE_SIGNER_PRIVATE_KEY as Hex, config.FLOAT_ORACLE_ADDRESS as Address, value);
      response.json({ attestation: input, signature, transaction: publishOracle(config.FLOAT_ORACLE_ADDRESS as Address, [value.marketId, value.priceE18, value.spotPriceE18, value.confidenceBps, value.timestamp, value.sequence, value.expiry], signature) });
    } catch (error) { protocolError(response, error); }
  });

  router.post("/quote", masterAdmin, async (request, response) => {
    try {
      const input = quote.parse(request.body) as Record<string, string | boolean>;
      if (!database || !rpc) throw new Error("quote validation dependencies are unavailable");
      const symbol = (input.market as string).trim().toUpperCase();
      const expectedMarketId = marketId(symbol);
      if ((input.marketId as string).toLowerCase() !== expectedMarketId.toLowerCase()) throw new Error("marketId does not match market");
      const marketResult = await database.query<{
        id: string; status: "active" | "restricted" | "pilot" | "disabled"; max_ticket_usdg: string; max_half_spread_bps: number;
        observed_at: Date | null; oracle_tradable: boolean | null;
      }>(
        `SELECT m.id,m.status,m.max_ticket_usdg,m.max_half_spread_bps,s.observed_at,s.oracle_tradable
         FROM public.markets m LEFT JOIN LATERAL (
           SELECT observed_at,oracle_tradable FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
         ) s ON true WHERE m.symbol=$1`, [symbol]
      );
      const marketRow = marketResult.rows[0];
      if (!marketRow || marketRow.status !== "active" || marketRow.oracle_tradable !== true) throw new Error("market is not tradable");
      if (!marketRow.observed_at || (Date.now() - marketRow.observed_at.getTime()) / 1000 > config.ORACLE_PRICE_MAX_AGE_SECONDS) throw new Error("market snapshot is stale");
      const quoteRows = await database.query<{ count: string; max_degradation: number | null }>(
        `SELECT count(*)::text,max(abs(execution_degradation_bps)) AS max_degradation FROM public.quote_samples
         WHERE market_id=$1 AND observed_at=(SELECT q2.observed_at FROM public.quote_samples q2 WHERE q2.market_id=$1 GROUP BY q2.observed_at HAVING count(*)=10 ORDER BY q2.observed_at DESC LIMIT 1)`, [marketRow.id]
      );
      if (quoteRows.rows[0]?.count !== "10" || (quoteRows.rows[0].max_degradation ?? Infinity) > marketRow.max_half_spread_bps) throw new Error("market quote quality is outside its configured band");
      const onchainMarket = await readClearingMarket(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, expectedMarketId);
      if (onchainMarket.state !== 1) throw new Error("on-chain market is not active");
      // Oracle publication is driven by the scheduled publisher. User quote
      // requests must never trigger publisher-paid transactions or invalidate
      // other users' signed quotes.
      const oraclePrice = await readOraclePrice(rpc, config.FLOAT_ORACLE_ADDRESS as Address, expectedMarketId);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiry = bigint(input.expiry as string);
      if (oraclePrice.sequence === 0n || now > oraclePrice.timestamp + BigInt(config.ORACLE_PRICE_MAX_AGE_SECONDS)) throw new Error("on-chain oracle price is stale");
      if (oraclePrice.confidenceBps > onchainMarket.maxOracleConfidenceBps) throw new Error("oracle confidence exceeds market limit");
      if (bigint(input.oracleSequence as string) !== oraclePrice.sequence) throw new Error("oracle sequence is stale");
      if (expiry <= now || expiry > boundedQuoteExpiry(now, oraclePrice.timestamp, config.ORACLE_PRICE_MAX_AGE_SECONDS, config.QUOTE_TTL_SECONDS)) throw new Error("quote expiry is outside the safe oracle window");
      if (bigint(input.maxLeverageE18 as string) !== onchainMarket.maxLeverageE18) throw new Error("quote leverage does not match market");
      const executionPriceE18 = bigint(input.executionPriceE18 as string);
      const sizeDeltaE18 = bigint(input.sizeDeltaE18 as string);
      if (sizeDeltaE18 === 0n) throw new Error("quote size must be non-zero");
      const quoteNotional = notionalForSize(sizeDeltaE18, executionPriceE18);
      if (quoteNotional > usdgUnits(marketRow.max_ticket_usdg) || quoteNotional > onchainMarket.maxPositionNotionalUsdg) throw new Error("quote notional exceeds market limit");
      if (bigint(input.feeUsdg as string) > quoteNotional * MAX_TRADING_FEE_BPS / BPS) throw new Error("quote fee exceeds protocol limit");
      if (deviationBps(executionPriceE18, oraclePrice.priceE18) > onchainMarket.maxExecutionDeviationBps) throw new Error("execution price exceeds oracle deviation limit");
      const value: TradeQuote = {
        marketId: input.marketId as Hex, trader: input.trader as Address, sizeDeltaE18,
        executionPriceE18,
        feeUsdg: bigint(input.feeUsdg as string), maxLeverageE18: bigint(input.maxLeverageE18 as string),
        oracleSequence: bigint(input.oracleSequence as string), nonce: bigint(input.nonce as string), expiry: bigint(input.expiry as string)
      };
      const position = await readClearingPosition(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, value.trader, expectedMarketId);
      const nextSize = position.sizeE18 + value.sizeDeltaE18;
      const riskIncreasing = !(position.sizeE18 !== 0n && ((position.sizeE18 > 0n && nextSize >= 0n && nextSize < position.sizeE18) || (position.sizeE18 < 0n && nextSize <= 0n && nextSize > position.sizeE18)));
      if (riskIncreasing && await readBadDebt(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address) !== 0n) throw new Error("new positions are paused while vault bad debt is outstanding");
      const signature = await signTradeQuote(config.QUOTE_SIGNER_PRIVATE_KEY as Hex, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, value);
      response.json({ quote: input, signature, transaction: executeTrade(config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, value, signature) });
    } catch (error) { protocolError(response, error); }
  });

  /**
   * Public quote issuance for a connected trader. The caller supplies only
   * intent; the API derives every signed execution field from its own live
   * snapshot, Uniswap sample matrix, and on-chain oracle/market state.
   */
  router.post("/trade-quote", async (request, response) => {
    try {
      if (!database || !rpc) throw new Error("quote validation dependencies are unavailable");
      const input = traderQuoteRequest.parse(request.body);
      const symbol = input.market.trim().toUpperCase();
      const id = marketId(symbol);
      const requestedNotional = bigint(input.notionalUsdg);
      if (requestedNotional === 0n) throw new Error("notional must be greater than zero");

      const marketResult = await database.query<{
        id: string; status: "active" | "restricted" | "pilot" | "disabled"; max_ticket_usdg: string;
        max_half_spread_bps: number; observed_at: Date | null; oracle_tradable: boolean | null;
      }>(
        `SELECT m.id,m.status,m.max_ticket_usdg,m.max_half_spread_bps,s.observed_at,s.oracle_tradable
         FROM public.markets m LEFT JOIN LATERAL (
           SELECT observed_at,oracle_tradable FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
         ) s ON true WHERE m.symbol=$1`, [symbol]
      );
      const marketRow = marketResult.rows[0];
      if (!marketRow || marketRow.status !== "active" || marketRow.oracle_tradable !== true) throw new Error("market is not tradable");
      if (!marketRow.observed_at || (Date.now() - marketRow.observed_at.getTime()) / 1_000 > config.ORACLE_PRICE_MAX_AGE_SECONDS) throw new Error("market snapshot is stale");
      if (requestedNotional > usdgUnits(marketRow.max_ticket_usdg)) throw new Error("quote notional exceeds market limit");

      const onchainMarket = await readClearingMarket(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, id);
      if (onchainMarket.state !== 1) throw new Error("on-chain market is not active");
      if (requestedNotional > onchainMarket.maxPositionNotionalUsdg) throw new Error("quote notional exceeds on-chain market limit");
      const oraclePrice = await readOraclePrice(rpc, config.FLOAT_ORACLE_ADDRESS as Address, id);
      const now = BigInt(Math.floor(Date.now() / 1_000));
      if (oraclePrice.sequence === 0n || now > oraclePrice.timestamp + BigInt(config.ORACLE_PRICE_MAX_AGE_SECONDS)) throw new Error("on-chain oracle price is stale");
      if (oraclePrice.confidenceBps > onchainMarket.maxOracleConfidenceBps) throw new Error("oracle confidence exceeds market limit");
      if (oraclePrice.circuitBroken) throw new Error("market is temporarily close-only");

      const direction = input.isLong ? "buy" : "sell";
      const sampleResult = await database.query<{ notional_usdg: string; execution_degradation_bps: number }>(
        `SELECT notional_usdg,execution_degradation_bps FROM public.quote_samples
         WHERE market_id=$1 AND direction=$2 AND observed_at=(
           SELECT observed_at FROM public.quote_samples WHERE market_id=$1 GROUP BY observed_at
           HAVING count(*)=10 ORDER BY observed_at DESC LIMIT 1
         ) AND notional_usdg >= $3
         ORDER BY notional_usdg ASC LIMIT 1`, [marketRow.id, direction, usdgDecimal(requestedNotional)]
      );
      const sample = sampleResult.rows[0];
      // The matrix is signed against the TWAP. A negative value is a better
      // executable buy price, not an invalid quote; its absolute magnitude is
      // still bounded by the market's configured execution band.
      if (!sample || !Number.isFinite(sample.execution_degradation_bps) || Math.abs(sample.execution_degradation_bps) > marketRow.max_half_spread_bps) throw new Error("market quote quality is outside its configured band");
      const degradationBps = BigInt(sample.execution_degradation_bps);
      const executionPriceE18 = input.isLong
        ? oraclePrice.priceE18 * (BPS + degradationBps) / BPS
        : oraclePrice.priceE18 * (BPS - degradationBps) / BPS;
      if (executionPriceE18 === 0n || deviationBps(executionPriceE18, oraclePrice.priceE18) > onchainMarket.maxExecutionDeviationBps) throw new Error("execution price exceeds oracle deviation limit");

      const value: TradeQuote = {
        marketId: id, trader: input.trader as Address,
        sizeDeltaE18: sizeForNotional(requestedNotional, executionPriceE18, input.isLong), executionPriceE18,
        feeUsdg: requestedNotional * TRADING_FEE_BPS / BPS,
        maxLeverageE18: onchainMarket.maxLeverageE18,
        oracleSequence: oraclePrice.sequence, nonce: quoteNonce(),
        expiry: boundedQuoteExpiry(now, oraclePrice.timestamp, config.ORACLE_PRICE_MAX_AGE_SECONDS, config.QUOTE_TTL_SECONDS)
      };
      if (value.expiry <= now) throw new Error("on-chain oracle price is too close to expiry");
      const position = await readClearingPosition(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, input.trader as Address, id);
      const requiredMargin = ceilingDiv(notionalForSize(value.sizeDeltaE18, value.executionPriceE18) * E18, onchainMarket.maxLeverageE18) + value.feeUsdg;
      if (position.sizeE18 === 0n && position.marginUsdg < requiredMargin) {
        throw new Error(`add at least ${usdgDecimal(requiredMargin)} USDG margin before opening this position`);
      }
      const nextSize = position.sizeE18 + value.sizeDeltaE18;
      const riskIncreasing = !(position.sizeE18 !== 0n && ((position.sizeE18 > 0n && value.sizeDeltaE18 < 0n) || (position.sizeE18 < 0n && value.sizeDeltaE18 > 0n)) && abs(value.sizeDeltaE18) <= abs(position.sizeE18));
      if (riskIncreasing) {
        if (await readBadDebt(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address) !== 0n) throw new Error("new positions are paused while vault bad debt is outstanding");
        const [exposure, vaultAssets] = await Promise.all([
          readClearingExposure(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, id),
          readVaultAssets(rpc, config.FLOAT_VAULT_ADDRESS as Address)
        ]);
        const nextLong = exposure.longBaseE18 - (position.sizeE18 > 0n ? abs(position.sizeE18) : 0n) + (nextSize > 0n ? abs(nextSize) : 0n);
        const nextShort = exposure.shortBaseE18 - (position.sizeE18 < 0n ? abs(position.sizeE18) : 0n) + (nextSize < 0n ? abs(nextSize) : 0n);
        const marketOpenInterest = notionalForSize(nextLong, value.executionPriceE18) + notionalForSize(nextShort, value.executionPriceE18);
        const marketSkew = nextLong > nextShort ? notionalForSize(nextLong - nextShort, value.executionPriceE18) : notionalForSize(nextShort - nextLong, value.executionPriceE18);
        if (marketOpenInterest > vaultAssets * BPS_MARKET_OPEN_INTEREST_CAP / BPS) throw new Error(`this position exceeds current ${symbol} market capacity`);
        if (marketSkew > vaultAssets * BPS_MARKET_SKEW_CAP / BPS) throw new Error(`this position exceeds current ${symbol} one-sided market capacity`);
      }
      const signature = await signTradeQuote(config.QUOTE_SIGNER_PRIVATE_KEY as Hex, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, value);
      response.json({
        quote: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "bigint" ? item.toString() : item])),
        sampled_notional_usdg: sample.notional_usdg,
        signature,
        transaction: executeTrade(config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, value, signature)
      });
    } catch (error) { protocolError(response, error); }
  });

  /**
   * A read-only preflight for the trade form. Unlike quote issuance, this
   * never refreshes the oracle, signs a quote, or spends publisher gas.
   * The final quote repeats these checks against its exact execution price.
   */
  router.post("/trade-check", async (request, response) => {
    try {
      if (!database || !rpc) throw new Error("trade validation dependencies are unavailable");
      const input = tradeCheckRequest.parse(request.body);
      const reject = (reason: string, field: "margin" | "leverage" = "leverage") => response.json({ acceptable: false, reason, field });
      const symbol = input.market.trim().toUpperCase();
      const id = marketId(symbol);
      const requestedNotional = bigint(input.notionalUsdg);
      const requestedMargin = bigint(input.marginUsdg);
      const targetLeverage = bigint(input.targetLeverage) * E18;
      if (requestedNotional === 0n || requestedMargin === 0n) return reject("Enter a margin amount before checking your position.", "margin");

      const marketResult = await database.query<{ id: string; status: "active" | "restricted" | "pilot" | "disabled"; max_ticket_usdg: string }>(
        "SELECT id,status,max_ticket_usdg FROM public.markets WHERE symbol=$1", [symbol]
      );
      const marketRow = marketResult.rows[0];
      if (!marketRow || marketRow.status !== "active") return reject("This market is not open for new positions.");
      const onchainMarket = await readClearingMarket(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, id);
      if (onchainMarket.state !== 1) return reject("This market is not open for new positions.");
      if (targetLeverage === 0n || targetLeverage > onchainMarket.maxLeverageE18) return reject("Choose leverage at or below this market's maximum.");
      if (requestedNotional > usdgUnits(marketRow.max_ticket_usdg) || requestedNotional > onchainMarket.maxPositionNotionalUsdg) return reject("Lower your leverage or margin to stay within this market's position limit.");

      const [position, oraclePrice] = await Promise.all([
        readClearingPosition(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, input.trader as Address, id),
        readOraclePrice(rpc, config.FLOAT_ORACLE_ADDRESS as Address, id)
      ]);
      const fee = requestedNotional * TRADING_FEE_BPS / BPS;
      const requiredMargin = ceilingDiv(requestedNotional * E18, onchainMarket.maxLeverageE18) + fee;
      if (position.marginUsdg + requestedMargin < requiredMargin) return reject("Add more margin or choose lower leverage for this position.", "margin");
      if (oraclePrice.sequence === 0n || oraclePrice.priceE18 === 0n || oraclePrice.circuitBroken) return reject("This market price is not ready for a new position. Try again shortly.");

      const nextSize = position.sizeE18 + sizeForNotional(requestedNotional, oraclePrice.priceE18, input.isLong);
      if (notionalForSize(nextSize, oraclePrice.priceE18) > onchainMarket.maxPositionNotionalUsdg) return reject("Lower your leverage or margin to stay within this market's position limit.");
      const riskIncreasing = !(position.sizeE18 !== 0n && ((position.sizeE18 > 0n && nextSize < position.sizeE18) || (position.sizeE18 < 0n && nextSize > position.sizeE18)));
      if (riskIncreasing) {
        if (await readBadDebt(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address) !== 0n) return reject("New positions are paused while vault bad debt is outstanding.");
        const [exposure, vaultAssets] = await Promise.all([
          readClearingExposure(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, id),
          readVaultAssets(rpc, config.FLOAT_VAULT_ADDRESS as Address)
        ]);
        const nextLong = exposure.longBaseE18 - (position.sizeE18 > 0n ? abs(position.sizeE18) : 0n) + (nextSize > 0n ? abs(nextSize) : 0n);
        const nextShort = exposure.shortBaseE18 - (position.sizeE18 < 0n ? abs(position.sizeE18) : 0n) + (nextSize < 0n ? abs(nextSize) : 0n);
        const openInterest = notionalForSize(nextLong, oraclePrice.priceE18) + notionalForSize(nextShort, oraclePrice.priceE18);
        const skew = nextLong > nextShort ? notionalForSize(nextLong - nextShort, oraclePrice.priceE18) : notionalForSize(nextShort - nextLong, oraclePrice.priceE18);
        if (openInterest > vaultAssets * BPS_MARKET_OPEN_INTEREST_CAP / BPS) return reject("Lower your leverage or margin: this market has reached its current capacity.");
        if (skew > vaultAssets * BPS_MARKET_SKEW_CAP / BPS) return reject("Lower your leverage or margin: this side of the market has reached its current capacity.");
      }
      response.json({ acceptable: true });
    } catch (error) { protocolError(response, error); }
  });

  router.post("/close-quote", async (request, response) => {
    try {
      if (!database || !rpc) throw new Error("quote validation dependencies are unavailable");
      const input = closeQuoteRequest.parse(request.body);
      const symbol = input.market.trim().toUpperCase();
      const id = marketId(symbol);
      const marketResult = await database.query<{
        id: string; status: "active" | "restricted" | "pilot" | "disabled"; max_half_spread_bps: number;
        observed_at: Date | null;
      }>(
        `SELECT m.id,m.status,m.max_half_spread_bps,s.observed_at
         FROM public.markets m LEFT JOIN LATERAL (
           SELECT observed_at FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
         ) s ON true WHERE m.symbol=$1`, [symbol]
      );
      const marketRow = marketResult.rows[0];
      if (!marketRow || marketRow.status === "disabled") throw new Error("market is unavailable");
      if (!marketRow.observed_at || (Date.now() - marketRow.observed_at.getTime()) / 1_000 > config.ORACLE_PRICE_MAX_AGE_SECONDS) throw new Error("market snapshot is stale");
      const onchainMarket = await readClearingMarket(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, id);
      if (onchainMarket.state === 0) throw new Error("on-chain market is unavailable");
      const oraclePrice = await readOraclePrice(rpc, config.FLOAT_ORACLE_ADDRESS as Address, id);
      const now = BigInt(Math.floor(Date.now() / 1_000));
      if (oraclePrice.sequence === 0n || now > oraclePrice.timestamp + BigInt(config.ORACLE_PRICE_MAX_AGE_SECONDS)) throw new Error("on-chain oracle price is stale");
      if (oraclePrice.confidenceBps > onchainMarket.maxOracleConfidenceBps) throw new Error("oracle confidence exceeds market limit");
      const position = await readClearingPosition(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, input.trader as Address, id);
      if (position.sizeE18 === 0n) throw new Error("no open position");
      const direction = position.sizeE18 > 0n ? "sell" : "buy";
      const positionNotional = notionalForSize(position.sizeE18, oraclePrice.priceE18);
      const sampleResult = await database.query<{ notional_usdg: string; execution_degradation_bps: number }>(
        `SELECT notional_usdg,execution_degradation_bps FROM public.quote_samples
         WHERE market_id=$1 AND direction=$2 AND observed_at=(
           SELECT observed_at FROM public.quote_samples WHERE market_id=$1 GROUP BY observed_at
           HAVING count(*)=10 ORDER BY observed_at DESC LIMIT 1
         )
         ORDER BY (notional_usdg < $3::numeric),
                  CASE WHEN notional_usdg >= $3::numeric THEN notional_usdg END ASC,
                  notional_usdg DESC
         LIMIT 1`, [marketRow.id, direction, usdgDecimal(positionNotional)]
      );
      const sample = sampleResult.rows[0];
      if (!oraclePrice.circuitBroken && (!sample || !Number.isFinite(sample.execution_degradation_bps) || Math.abs(sample.execution_degradation_bps) > marketRow.max_half_spread_bps)) throw new Error("market quote quality is outside its configured band");
      // Preserve exits during a breaker, but price them at the on-chain TWAP
      // instead of a potentially manipulated pool sample.
      const degradationBps = oraclePrice.circuitBroken ? 0n : BigInt(sample!.execution_degradation_bps);
      const executionPriceE18 = direction === "buy"
        ? oraclePrice.priceE18 * (BPS + degradationBps) / BPS
        : oraclePrice.priceE18 * (BPS - degradationBps) / BPS;
      if (executionPriceE18 === 0n || deviationBps(executionPriceE18, oraclePrice.priceE18) > onchainMarket.maxExecutionDeviationBps) throw new Error("execution price exceeds oracle deviation limit");
      const sizeDeltaE18 = -position.sizeE18;
      const tradeNotional = notionalForSize(sizeDeltaE18, executionPriceE18);
      const value: TradeQuote = {
        marketId: id, trader: input.trader as Address, sizeDeltaE18, executionPriceE18,
        feeUsdg: tradeNotional * TRADING_FEE_BPS / BPS,
        maxLeverageE18: onchainMarket.maxLeverageE18,
        oracleSequence: oraclePrice.sequence, nonce: quoteNonce(),
        expiry: boundedQuoteExpiry(now, oraclePrice.timestamp, config.ORACLE_PRICE_MAX_AGE_SECONDS, config.QUOTE_TTL_SECONDS)
      };
      if (value.expiry <= now) throw new Error("on-chain oracle price is too close to expiry");
      const signature = await signTradeQuote(config.QUOTE_SIGNER_PRIVATE_KEY as Hex, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, value);
      response.json({
        quote: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "bigint" ? item.toString() : item])),
        sampled_notional_usdg: sample.notional_usdg,
        signature,
        transaction: executeTrade(config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, value, signature)
      });
    } catch (error) { protocolError(response, error); }
  });

  router.post("/approve", (request, response) => {
    try { const body = z.object({ amountUsdg: uint }).parse(request.body); response.json({ transaction: approveUsdG(config.USDG_ADDRESS as Address, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, bigint(body.amountUsdg)) }); }
    catch (error) { protocolError(response, error); }
  });

  router.post("/vault-approve", (request, response) => {
    try { const body = z.object({ amountUsdg: uint }).parse(request.body); response.json({ transaction: approveUsdG(config.USDG_ADDRESS as Address, config.FLOAT_VAULT_ADDRESS as Address, bigint(body.amountUsdg)) }); }
    catch (error) { protocolError(response, error); }
  });

  router.post("/vault-deposit", (request, response) => {
    try {
      const body = z.object({ amountUsdg: uint, receiver: address }).parse(request.body);
      if (bigint(body.amountUsdg) === 0n) throw new Error("amount must be greater than zero");
      response.json({ transaction: depositVault(config.FLOAT_VAULT_ADDRESS as Address, bigint(body.amountUsdg), body.receiver as Address) });
    } catch (error) { protocolError(response, error); }
  });

  router.post("/vault-withdraw", (request, response) => {
    try {
      const body = z.object({ shares: uint, receiver: address }).parse(request.body);
      if (bigint(body.shares) === 0n) throw new Error("shares must be greater than zero");
      response.json({ transaction: withdrawVault(config.FLOAT_VAULT_ADDRESS as Address, bigint(body.shares), body.receiver as Address) });
    } catch (error) { protocolError(response, error); }
  });

  router.post("/deposit", (request, response) => {
    try { const body = z.object({ market: z.string().min(1), amountUsdg: uint }).parse(request.body); response.json({ transaction: depositMargin(config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, marketId(body.market), bigint(body.amountUsdg)) }); }
    catch (error) { protocolError(response, error); }
  });

  router.post("/withdraw", (request, response) => {
    try { const body = z.object({ market: z.string().min(1), amountUsdg: uint }).parse(request.body); response.json({ transaction: withdrawMargin(config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, marketId(body.market), bigint(body.amountUsdg)) }); }
    catch (error) { protocolError(response, error); }
  });

  router.post("/liquidate", (request, response) => {
    try { const body = z.object({ market: z.string().min(1), trader: address }).parse(request.body); response.json({ transaction: liquidate(config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, body.trader as Address, marketId(body.market)) }); }
    catch (error) { protocolError(response, error); }
  });

  router.post("/claim", (request, response) => {
    try {
      const body = z.object({ receiver: address }).parse(request.body);
      response.json({ transaction: claimProtocolBalance(config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, body.receiver as Address) });
    } catch (error) { protocolError(response, error); }
  });

  router.post("/claim-deferred", (request, response) => {
    try {
      const body = z.object({ receiver: address }).parse(request.body);
      response.json({ transaction: claimDeferredPayout(config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, body.receiver as Address) });
    } catch (error) { protocolError(response, error); }
  });

  router.post("/admin/enable-market", masterAdmin, (request, response) => {
    try { const body = z.object({ market: z.string().min(1), enabled: z.boolean() }).parse(request.body); response.json({ transaction: enableMarket(config.FLOAT_ORACLE_ADDRESS as Address, marketId(body.market), body.enabled) }); }
    catch (error) { protocolError(response, error); }
  });

  router.post("/admin/configure-market", masterAdmin, (request, response) => {
    try {
      const body = z.object({ market: z.string().min(1), state: z.number().int().min(1).max(3), maxLeverageE18: uint, maintenanceMarginBps: uint, maxExecutionDeviationBps: uint, maxOracleConfidenceBps: uint, maxPositionNotionalUsdg: uint }).parse(request.body);
      response.json({ transaction: configureMarket(config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, marketId(body.market), [body.state, bigint(body.maxLeverageE18), bigint(body.maintenanceMarginBps), bigint(body.maxExecutionDeviationBps), bigint(body.maxOracleConfidenceBps), bigint(body.maxPositionNotionalUsdg)]) });
    } catch (error) { protocolError(response, error); }
  });

  return router;
}
