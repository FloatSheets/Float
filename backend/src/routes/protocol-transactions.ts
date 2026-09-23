import { Router, type Response } from "express";
import { z } from "zod";
import type { Address } from "viem";
import type { Hex } from "viem";

import type { AppConfig } from "../config";
import {
  approveUsdG, configureMarket, depositMargin, enableMarket, liquidate, marketId, withdrawMargin
} from "../chain/protocol";
import { publishOracle, executeTrade } from "../chain/protocol";
import { requireMasterAdmin } from "../auth/master-admin";
import { signPriceAttestation, signTradeQuote } from "../signing/signer";
import type { PriceAttestation, TradeQuote } from "../signing/types";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^\d+$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const attestation = z.object({ marketId: hex, priceE18: uint, confidenceBps: uint, timestamp: uint, sequence: uint, expiry: uint });
const quote = z.object({
  marketId: hex, trader: address, isLong: z.boolean(), notionalUsdg: uint, executionPriceE18: uint,
  feeUsdg: uint, maxLeverageE18: uint, oracleSequence: uint, nonce: uint, expiry: uint
});

function bigint(value: string): bigint {
  return BigInt(value);
}

function protocolError(response: Response, error: unknown): void {
  response.status(400).json({ error: error instanceof Error ? error.message : "invalid request" });
}

export function createProtocolTransactionsRouter(config: AppConfig): Router {
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
