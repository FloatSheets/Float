import { Router, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Address } from "viem";
import type { Hex } from "viem";
import type { Pool } from "pg";

import type { AppConfig } from "../config";
import {
  approveUsdG, configureMarket, depositMargin, enableMarket, liquidate, marketId, withdrawMargin
} from "../chain/protocol";
import { publishOracle, executeTrade } from "../chain/protocol";
import { requireMasterAdmin } from "../auth/master-admin";
import { signPriceAttestation, signTradeQuote } from "../signing/signer";
import type { PriceAttestation, TradeQuote } from "../signing/types";
import type { RpcTransport } from "../chain/rpc";
import { readClearingMarket, readOraclePrice } from "../chain/protocol-read";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^\d+$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const attestation = z.object({ marketId: hex, priceE18: uint, confidenceBps: uint, timestamp: uint, sequence: uint, expiry: uint });
const quote = z.object({
  market: z.string().min(1), marketId: hex, trader: address, isLong: z.boolean(), notionalUsdg: uint, executionPriceE18: uint,
  feeUsdg: uint, maxLeverageE18: uint, oracleSequence: uint, nonce: uint, expiry: uint
});
const traderQuoteRequest = z.object({
  market: z.string().min(1).max(16), trader: address, isLong: z.boolean(), notionalUsdg: uint
});
const TRADING_FEE_BPS = 6n;
const BPS = 10_000n;

function bigint(value: string): bigint {
  return BigInt(value);
}

function usdgUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0").slice(0, 6)}`);
}

function deviationBps(a: bigint, b: bigint): bigint {
  const delta = a > b ? a - b : b - a;
  return delta * 10_000n / b;
}

function quoteNonce(): bigint {
  return BigInt(`0x${randomBytes(8).toString("hex")}`);
}

function protocolError(response: Response, error: unknown): void {
  response.status(400).json({ error: error instanceof Error ? error.message : "invalid request" });
}

export function createProtocolTransactionsRouter(config: AppConfig, database?: Pool, rpc?: RpcTransport): Router {
  const router = Router();
  const masterAdmin = requireMasterAdmin(config);

  router.post("/oracle-attestation", masterAdmin, async (request, response) => {
    try {
      const input = attestation.parse(request.body) as Record<string, string>;
      const value: PriceAttestation = {
        marketId: input.marketId as Hex, priceE18: bigint(input.priceE18), confidenceBps: bigint(input.confidenceBps),
        timestamp: bigint(input.timestamp), sequence: bigint(input.sequence), expiry: bigint(input.expiry)
      };
      const signature = await signPriceAttestation(config.ORACLE_SIGNER_PRIVATE_KEY as Hex, config.FLOAT_ORACLE_ADDRESS as Address, value);
      response.json({ attestation: input, signature, transaction: publishOracle(config.FLOAT_ORACLE_ADDRESS as Address, [value.marketId, value.priceE18, value.confidenceBps, value.timestamp, value.sequence, value.expiry], signature) });
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
         FROM markets m LEFT JOIN LATERAL (
           SELECT observed_at,oracle_tradable FROM pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
         ) s ON true WHERE m.symbol=$1`, [symbol]
      );
      const marketRow = marketResult.rows[0];
      if (!marketRow || marketRow.status !== "active" || marketRow.oracle_tradable !== true) throw new Error("market is not tradable");
      if (!marketRow.observed_at || (Date.now() - marketRow.observed_at.getTime()) / 1000 > config.ORACLE_PRICE_MAX_AGE_SECONDS) throw new Error("market snapshot is stale");
      const quoteRows = await database.query<{ count: string; max_degradation: number | null }>(
        `SELECT count(*)::text,max(execution_degradation_bps) AS max_degradation FROM quote_samples
         WHERE market_id=$1 AND observed_at=(SELECT q2.observed_at FROM quote_samples q2 WHERE q2.market_id=$1 GROUP BY q2.observed_at HAVING count(*)=10 ORDER BY q2.observed_at DESC LIMIT 1)`, [marketRow.id]
      );
      if (quoteRows.rows[0]?.count !== "10" || (quoteRows.rows[0].max_degradation ?? Infinity) > marketRow.max_half_spread_bps) throw new Error("market quote quality is outside its configured band");
      const onchainMarket = await readClearingMarket(rpc, config.FLOAT_CLEARING_HOUSE_ADDRESS as Address, expectedMarketId);
      if (onchainMarket.state !== 1) throw new Error("on-chain market is not active");
      const oraclePrice = await readOraclePrice(rpc, config.FLOAT_ORACLE_ADDRESS as Address, expectedMarketId);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiry = bigint(input.expiry as string);
      if (oraclePrice.sequence === 0n || now > oraclePrice.timestamp + BigInt(config.ORACLE_PRICE_MAX_AGE_SECONDS)) throw new Error("on-chain oracle price is stale");
      if (oraclePrice.confidenceBps > onchainMarket.maxOracleConfidenceBps) throw new Error("oracle confidence exceeds market limit");
      if (bigint(input.oracleSequence as string) !== oraclePrice.sequence) throw new Error("oracle sequence is stale");
      if (expiry <= now || expiry > now + BigInt(config.QUOTE_TTL_SECONDS)) throw new Error("quote expiry is outside allowed TTL");
      if (bigint(input.maxLeverageE18 as string) !== onchainMarket.maxLeverageE18) throw new Error("quote leverage does not match market");
      if (bigint(input.notionalUsdg as string) > usdgUnits(marketRow.max_ticket_usdg) || bigint(input.notionalUsdg as string) > onchainMarket.maxPositionNotionalUsdg) throw new Error("quote notional exceeds market limit");
      if (deviationBps(bigint(input.executionPriceE18 as string), oraclePrice.priceE18) > onchainMarket.maxExecutionDeviationBps) throw new Error("execution price exceeds oracle deviation limit");
      const value: TradeQuote = {
        marketId: input.marketId as Hex, trader: input.trader as Address, isLong: input.isLong as boolean,
        notionalUsdg: bigint(input.notionalUsdg as string), executionPriceE18: bigint(input.executionPriceE18 as string),
        feeUsdg: bigint(input.feeUsdg as string), maxLeverageE18: bigint(input.maxLeverageE18 as string),
        oracleSequence: bigint(input.oracleSequence as string), nonce: bigint(input.nonce as string), expiry: bigint(input.expiry as string)
      };
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
         FROM markets m LEFT JOIN LATERAL (
           SELECT observed_at,oracle_tradable FROM pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
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

      const direction = input.isLong ? "buy" : "sell";
      const sampleResult = await database.query<{ notional_usdg: string; execution_degradation_bps: number }>(
        `SELECT notional_usdg,execution_degradation_bps FROM quote_samples
         WHERE market_id=$1 AND direction=$2 AND observed_at=(
           SELECT observed_at FROM quote_samples WHERE market_id=$1 GROUP BY observed_at
           HAVING count(*)=10 ORDER BY observed_at DESC LIMIT 1
         ) AND notional_usdg >= $3
         ORDER BY notional_usdg ASC LIMIT 1`, [marketRow.id, direction, input.notionalUsdg]
      );
      const sample = sampleResult.rows[0];
      if (!sample || !Number.isFinite(sample.execution_degradation_bps) || sample.execution_degradation_bps < 0 || sample.execution_degradation_bps > marketRow.max_half_spread_bps) throw new Error("market quote quality is outside its configured band");
      const degradationBps = BigInt(sample.execution_degradation_bps);
      const executionPriceE18 = input.isLong
        ? oraclePrice.priceE18 * (BPS + degradationBps) / BPS
        : oraclePrice.priceE18 * (BPS - degradationBps) / BPS;
      if (executionPriceE18 === 0n || deviationBps(executionPriceE18, oraclePrice.priceE18) > onchainMarket.maxExecutionDeviationBps) throw new Error("execution price exceeds oracle deviation limit");

      const value: TradeQuote = {
        marketId: id, trader: input.trader as Address, isLong: input.isLong,
        notionalUsdg: requestedNotional, executionPriceE18,
        feeUsdg: requestedNotional * TRADING_FEE_BPS / BPS,
        maxLeverageE18: onchainMarket.maxLeverageE18,
        oracleSequence: oraclePrice.sequence, nonce: quoteNonce(), expiry: now + BigInt(config.QUOTE_TTL_SECONDS)
      };
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
