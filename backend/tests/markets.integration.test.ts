import "dotenv/config";

import express from "express";
import { expect, test } from "bun:test";
import request from "supertest";

import { db } from "../src/db";
import { toFunctionSelector } from 'viem';
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
  const config = await request(app).get("/v1/markets/NVDA");
  expect(response.status).toBe(200);
  expect(response.body.market).toBe("NVDA");
  expect(response.body.quotes).toHaveLength(10);
  const notionals = Array.from(new Set<number>(
    response.body.quotes.map((quote: { notional_usdg: string }) => Number(quote.notional_usdg))
  )).sort((a, b) => a - b);
  expect(notionals).toHaveLength(5);
  expect(notionals[0]).toBe(5);
  expect(notionals[1]).toBe(10);
  expect(notionals[4]).toBe(Number(config.body.market.max_ticket_usdg));
  expect(notionals.every((notional) => notional <= Number(config.body.market.max_ticket_usdg))).toBe(true);
}, 60_000);

test("reports a live risk state for NVDA", async () => {
  const response = await request(app).get("/v1/markets/NVDA/risk");
  expect(response.status).toBe(200);
  expect(["active", "close_only"]).toContain(response.body.state);
  expect(response.body.snapshot_age_seconds).toBeNumber();
}, 60_000);

test('reads oracle confidence and trade gate for NVDA from the chain transport', async () => {
  const word = (value: bigint) => value.toString(16).padStart(64, '0');
  const now = BigInt(Math.floor(Date.now() / 1_000));
  const rpc = {
    async call({ data }: { to: `0x${string}`; data: `0x${string}` }) {
      if (data.slice(0, 10) === toFunctionSelector('getPrice(bytes32)')) {
        return `0x${[100n, 101n, 10n, 1n, now, 5n, 0n].map(word).join('')}` as `0x${string}`;
      }
      return `0x${[1n, 10n, 100n, 100n, 50n, 1000n].map(word).join('')}` as `0x${string}`;
    }
  };
  const liveApp=express();
  liveApp.use('/v1/markets',createMarketsRouter(db,120,{
    rpc,clearingHouse:"0xb91fE7c85E6645D2134f1C313Ea787812d43bfa8",oracle:"0x841E9EBb75Da9F3B4045434cB38F4892f37F4Afd"
  }));
  const response=await request(liveApp).get('/v1/markets/NVDA/live');
  expect(response.status).toBe(200);
  expect(['LIVE','READY','CLOSE_ONLY','HALTED']).toContain(response.body.state);
  expect(Number(response.body.oracle_confidence_bps)).toBeGreaterThanOrEqual(0);
  expect(Number(response.body.oracle_confidence_limit_bps)).toBeGreaterThanOrEqual(Number(response.body.oracle_confidence_bps));
  expect(typeof response.body.oracle_fresh).toBe('boolean');
},60_000);
