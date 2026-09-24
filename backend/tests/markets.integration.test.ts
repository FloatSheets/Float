import "dotenv/config";

import express from "express";
import { expect, test } from "bun:test";
import request from "supertest";

import { db } from "../src/db";
import { createRpcTransport } from '../src/chain/rpc';
import { loadConfig } from '../src/config';
import { createMarketsRouter } from "../src/routes/markets";

const app = express();
app.use("/v1/markets", createMarketsRouter(db));

test("lists the real configured direct-USDG markets", async () => {
  const response = await request(app).get("/v1/markets");
  expect(response.status).toBe(200);
  expect(response.body.markets).toHaveLength(10);
  expect(response.body.markets.map((market: { symbol: string }) => market.symbol)).toContain("NVDA");
  expect(response.body.markets.map((market: { symbol: string }) => market.symbol)).not.toContain("GME");
}, 60_000);

test("returns immutable direct-USDG configuration for NVDA", async () => {
  const response = await request(app).get("/v1/markets/NVDA");
  expect(response.status).toBe(200);
  expect(response.body.market.symbol).toBe("NVDA");
  expect(response.body.market.settlement_asset).toBe("USDG");
  expect(response.body.market.uniswap_v3_fee_tier).toBe(500);
}, 60_000);

test("returns 404 for a market without recorded quotes", async () => {
  const response = await request(app).get("/v1/markets/GME/quotes");
  expect(response.status).toBe(404);
}, 60_000);

test("returns the live five-notional, two-sided NVDA quote matrix", async () => {
  const response = await request(app).get("/v1/markets/NVDA/quotes");
  expect(response.status).toBe(200);
  expect(response.body.market).toBe("NVDA");
  expect(response.body.quotes).toHaveLength(10);
  expect(new Set(response.body.quotes.map((quote: { notional_usdg: string }) => quote.notional_usdg))).toEqual(
    new Set(["5.000000", "10.000000", "1000.000000", "10000.000000", "50000.000000"])
  );
}, 60_000);

test("reports a live risk state for NVDA", async () => {
  const response = await request(app).get("/v1/markets/NVDA/risk");
  expect(response.status).toBe(200);
  expect(["active", "close_only"]).toContain(response.body.state);
  expect(response.body.snapshot_age_seconds).toBeNumber();
}, 60_000);

test('reads the current on-chain oracle confidence and trade gate for NVDA', async () => {
  const config=loadConfig();
  const liveApp=express();
  liveApp.use('/v1/markets',createMarketsRouter(db,config.ORACLE_PRICE_MAX_AGE_SECONDS,{
    rpc:createRpcTransport(config.RHC_RPC_URL),clearingHouse:config.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`,oracle:config.FLOAT_ORACLE_ADDRESS as `0x${string}`
  }));
  const response=await request(liveApp).get('/v1/markets/NVDA/live');
  expect(response.status).toBe(200);
  expect(['LIVE','READY','CLOSE_ONLY','HALTED']).toContain(response.body.state);
  expect(Number(response.body.oracle_confidence_bps)).toBeGreaterThanOrEqual(0);
  expect(Number(response.body.oracle_confidence_limit_bps)).toBeGreaterThanOrEqual(Number(response.body.oracle_confidence_bps));
  expect(typeof response.body.oracle_fresh).toBe('boolean');
},60_000);
