import "dotenv/config";

import { beforeEach, expect, test } from "bun:test";
import express from "express";
import request from "supertest";

import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { easternToUtc, HaltMonitor, haltMessage, parseHaltFeed, readActiveHalt } from "../src/markets/halts";
import { createMarketsRouter } from "../src/routes/markets";

function item(fields: Record<string, string>): string {
  const tags = ["HaltDate", "HaltTime", "IssueSymbol", "IssueName", "Market", "ReasonCode", "PauseThresholdPrice", "ResumptionDate", "ResumptionQuoteTime", "ResumptionTradeTime"]
    .map((name) => fields[name] ? `<ndaq:${name}>${fields[name]}</ndaq:${name}>` : `<ndaq:${name} />`).join("\n");
  return `<item><title>${fields.IssueSymbol ?? ""}</title>${tags}</item>`;
}

function feed(...items: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/"><channel>${items.join("")}</channel></rss>`;
}

function fetcherFor(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

beforeEach(async () => {
  await migrate();
  await db.query("TRUNCATE public.exchange_halts, public.exchange_halt_feed");
});

test("converts Eastern feed times to UTC across daylight saving", () => {
  // EDT (UTC-4) in October, EST (UTC-5) in December.
  expect(easternToUtc("10/21/2026", "19:50:00.000")?.toISOString()).toBe("2026-10-21T23:50:00.000Z");
  expect(easternToUtc("12/01/2026", "09:30:00.000")?.toISOString()).toBe("2026-12-01T14:30:00.000Z");
  expect(easternToUtc("13/01/2026", "09:30:00")).toBeNull();
});

test("parses issue halts and keeps market-wide breakers without a symbol", () => {
  const halts = parseHaltFeed(feed(
    item({ HaltDate: "10/22/2026", HaltTime: "10:01:02.000", IssueSymbol: "NVDA", Market: "NASDAQ", ReasonCode: "LUDP", ResumptionDate: "10/22/2026", ResumptionTradeTime: "10:06:02.000" }),
    item({ HaltDate: "10/22/2026", HaltTime: "11:00:00.000", Market: "NYSE", ReasonCode: "MWC1" }),
    item({ HaltDate: "10/22/2026", HaltTime: "11:00:00.000", Market: "NYSE", ReasonCode: "T1" })
  ));
  expect(halts).toHaveLength(2);
  expect(halts[0]).toMatchObject({ symbol: "NVDA", listingMarket: "NASDAQ", reasonCode: "LUDP" });
  expect(halts[0]!.resumptionTradeAt?.toISOString()).toBe("2026-10-22T14:06:02.000Z");
  expect(halts[1]).toMatchObject({ symbol: "", reasonCode: "MWC1" });
});

test("mirrors only listed markets and ends halts at their resumption time", async () => {
  const now = new Date("2026-10-22T15:00:00.000Z"); // 11:00 ET
  const monitor = new HaltMonitor(db, "https://feed.test", fetcherFor(feed(
    item({ HaltDate: "10/22/2026", HaltTime: "10:30:00.000", IssueSymbol: "QUBT", Market: "NASDAQ", ReasonCode: "T1" }),
    item({ HaltDate: "10/22/2026", HaltTime: "10:40:00.000", IssueSymbol: "TSLA", Market: "NASDAQ", ReasonCode: "LUDP", ResumptionDate: "10/22/2026", ResumptionTradeTime: "10:45:00.000" }),
    item({ HaltDate: "10/22/2026", HaltTime: "10:50:00.000", IssueSymbol: "AXNX", Market: "NASDAQ", ReasonCode: "T1" })
  )));
  await monitor.refresh(now);

  const qubt = await readActiveHalt(db, "qubt");
  expect(qubt).toMatchObject({ symbol: "QUBT", listing_market: "NASDAQ", reason_code: "T1", reason: "news pending", resumption_trade_at: null });
  expect(haltMessage(qubt!)).toContain("you can still close");
  // TSLA already resumed; AXNX is not a FloatSheets market.
  expect(await readActiveHalt(db, "TSLA")).toBeNull();
  const stored = await db.query("SELECT 1 FROM public.exchange_halts WHERE symbol='AXNX'");
  expect(stored.rowCount).toBe(0);

  // A halt that drops out of the feed is no longer active.
  await new HaltMonitor(db, "https://feed.test", fetcherFor(feed())).refresh(now);
  expect(await readActiveHalt(db, "QUBT")).toBeNull();
}, 60_000);

test("applies a market-wide circuit breaker to every market", async () => {
  const monitor = new HaltMonitor(db, "https://feed.test", fetcherFor(feed(
    item({ HaltDate: "10/22/2026", HaltTime: "10:30:00.000", Market: "NYSE", ReasonCode: "MWC1" })
  )));
  await monitor.refresh(new Date("2026-10-22T14:35:00.000Z"));
  const listed = await db.query<{ count: string }>("SELECT count(*)::text FROM public.markets");
  const halted = await db.query<{ count: string }>("SELECT count(*)::text FROM public.exchange_halts WHERE active");
  expect(halted.rows[0]!.count).toBe(listed.rows[0]!.count);
  expect((await readActiveHalt(db, "NVDA"))?.reason).toBe("market-wide circuit breaker level 1");
}, 60_000);

test("keeps known halts when the feed fails and reports the failure", async () => {
  const now = new Date("2026-10-22T15:00:00.000Z");
  await new HaltMonitor(db, "https://feed.test", fetcherFor(feed(
    item({ HaltDate: "10/22/2026", HaltTime: "10:30:00.000", IssueSymbol: "MSTR", Market: "NASDAQ", ReasonCode: "T12" })
  ))).refresh(now);
  await new HaltMonitor(db, "https://feed.test", fetcherFor("Service Unavailable", 503)).refresh(now);

  expect((await readActiveHalt(db, "MSTR"))?.reason_code).toBe("T12");
  const app = express();
  app.use("/v1/markets", createMarketsRouter(db));
  const status = await request(app).get("/v1/markets/halts");
  expect(status.status).toBe(200);
  expect(status.body.feed.last_error).toContain("HTTP 503");
  expect(status.body.active.map((halt: { symbol: string }) => halt.symbol)).toEqual(["MSTR"]);

  const markets = await request(app).get("/v1/markets");
  const mstr = markets.body.markets.find((row: { symbol: string }) => row.symbol === "MSTR");
  const nvda = markets.body.markets.find((row: { symbol: string }) => row.symbol === "NVDA");
  expect(mstr.exchange_halt.reason).toBe("additional information requested");
  expect(nvda.exchange_halt).toBeNull();
}, 60_000);
