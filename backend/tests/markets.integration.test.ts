import "dotenv/config";

import express from "express";
import { expect, test } from "bun:test";
import request from "supertest";

import { db } from "../src/db";
import { createMarketsRouter } from "../src/routes/markets";

const app = express();
app.use("/v1/markets", createMarketsRouter(db));

test("lists the real configured direct-USDG markets", async () => {
  const response = await request(app).get("/v1/markets");
  expect(response.status).toBe(200);
  expect(response.body.markets).toHaveLength(10);
  expect(response.body.markets.map((market: { symbol: string }) => market.symbol)).toContain("NVDA");
  expect(response.body.markets.map((market: { symbol: string }) => market.symbol)).not.toContain("GME");
});

test("returns immutable direct-USDG configuration for NVDA", async () => {
  const response = await request(app).get("/v1/markets/NVDA");
  expect(response.status).toBe(200);
  expect(response.body.market.symbol).toBe("NVDA");
  expect(response.body.market.settlement_asset).toBe("USDG");
  expect(response.body.market.uniswap_v3_fee_tier).toBe(500);
});

test("returns 404 for a market without recorded quotes", async () => {
  const response = await request(app).get("/v1/markets/GME/quotes");
  expect(response.status).toBe(404);
});

test("returns the live five-notional, two-sided NVDA quote matrix", async () => {
  const response = await request(app).get("/v1/markets/NVDA/quotes");
  expect(response.status).toBe(200);
  expect(response.body.market).toBe("NVDA");
  expect(response.body.quotes).toHaveLength(10);
  expect(new Set(response.body.quotes.map((quote: { notional_usdg: string }) => quote.notional_usdg))).toEqual(
    new Set(["5.000000", "10.000000", "1000.000000", "10000.000000", "50000.000000"])
  );
});

test("reports a live risk state for NVDA", async () => {
  const response = await request(app).get("/v1/markets/NVDA/risk");
  expect(response.status).toBe(200);
  expect(["active", "close_only"]).toContain(response.body.state);
  expect(response.body.snapshot_age_seconds).toBeNumber();
});
