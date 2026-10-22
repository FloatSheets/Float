import "dotenv/config";

import { afterEach, beforeEach, expect, test } from "bun:test";
import express from "express";
import request from "supertest";

import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import {
  CorporateActionMonitor, corporateActionPolicy, parseSplitRatio, readCorporateAction, splitNear, type CorporateActionOptions
} from "../src/markets/corporate-actions";
import { oracleCatchUp } from "../src/oracle/publisher";
import { createMarketsRouter } from "../src/routes/markets";

const options: CorporateActionOptions = { enabled: true, splitCloseOnlyDays: 7, largeDividendBps: 200 };
const e18 = (value: number) => BigInt(Math.round(value * 1e6)) * 10n ** 12n;
const inserted: Date[] = [];

beforeEach(async () => {
  await migrate();
  await db.query("TRUNCATE public.corporate_actions, public.corporate_action_feed");
});

afterEach(async () => {
  if (inserted.length) await db.query("DELETE FROM public.pool_snapshots WHERE observed_at = ANY($1::timestamptz[])", [inserted]);
  inserted.length = 0;
});

test("parses forward and reverse split ratios", () => {
  expect(parseSplitRatio("10 : 1")).toEqual({ splitNew: 10, splitOld: 1 });
  expect(parseSplitRatio("1:10")).toEqual({ splitNew: 1, splitOld: 10 });
  expect(parseSplitRatio("3:1")).toEqual({ splitNew: 3, splitOld: 1 });
  expect(parseSplitRatio("1 : 1")).toBeNull();
  expect(parseSplitRatio("special")).toBeNull();
});

test("makes a market close-only for the seven days before a split", () => {
  const split = { symbol: "NVDA", kind: "split" as const, exDate: "2026-11-05", splitNew: 10, splitOld: 1, amountUsd: null };
  // Close-only starts exactly 7 x 24h before 04:00 ET on the ex-date, matching the contract's
  // 7-day duration in seconds. Across the 1 November clock change that is 05:00 EDT (09:00Z).
  // A notice shows three days earlier.
  expect(corporateActionPolicy(split, new Date("2026-10-26T07:00:00.000Z"), options, 200)).toBeNull();
  const notice = corporateActionPolicy(split, new Date("2026-10-27T12:00:00.000Z"), options, 200)!;
  expect(notice).toMatchObject({ close_only: false, close_only_from: "2026-10-29T09:00:00.000Z", expected_price_change_pct: -90, ratio: "10-for-1" });
  expect(corporateActionPolicy(split, new Date("2026-10-29T08:59:00.000Z"), options, 200)!.close_only).toBe(false);
  expect(corporateActionPolicy(split, new Date("2026-10-29T09:00:00.000Z"), options, 200)!.close_only).toBe(true);
  // The window ends at 20:00 ET on the ex-date, which is EST after 1 November.
  expect(corporateActionPolicy(split, new Date("2026-11-06T00:59:00.000Z"), options, 200)!.close_only).toBe(true);
  expect(corporateActionPolicy(split, new Date("2026-11-06T01:00:00.000Z"), options, 200)).toBeNull();
  expect(notice.summary).toBe("NVDA splits 10-for-1 on Nov 5. Positions cannot be resized for a split, so NVDA is close-only from Oct 29 through the split day; open positions reach their 7-day limit and close before it.");

  const reverse = corporateActionPolicy({ ...split, symbol: "QUBT", splitNew: 1, splitOld: 10 }, new Date("2026-10-30T12:00:00.000Z"), options, 5)!;
  expect(reverse.expected_price_change_pct).toBe(900);
  expect(reverse.summary).toContain("QUBT reverse splits 1-for-10");
});

test("only pauses opens around large dividends", () => {
  const dividend = { symbol: "MSTR", kind: "cash_dividend" as const, exDate: "2026-11-02", splitNew: null, splitOld: null, amountUsd: 10 };
  // $10 on a $100 stock is 10%: close-only from 20:00 ET the previous trading day to 09:40 ET on the ex-date.
  const before = corporateActionPolicy(dividend, new Date("2026-10-30T12:00:00.000Z"), options, 100)!;
  expect(before).toMatchObject({ close_only: false, close_only_from: "2026-10-31T00:00:00.000Z", close_only_until: "2026-11-02T14:40:00.000Z", expected_price_change_pct: -10 });
  expect(corporateActionPolicy(dividend, new Date("2026-11-01T12:00:00.000Z"), options, 100)!.close_only).toBe(true);
  expect(corporateActionPolicy(dividend, new Date("2026-11-02T14:40:00.000Z"), options, 100)).toBeNull();

  // A regular dividend is a notice only.
  const regular = corporateActionPolicy({ ...dividend, amountUsd: 0.5 }, new Date("2026-11-01T12:00:00.000Z"), options, 400)!;
  expect(regular.close_only).toBe(false);
  expect(regular.close_only_from).toBeNull();
  expect(regular.summary).toContain("longs absorb the drop");
});

test("mirrors the Nasdaq calendars for listed markets and keeps admin entries", async () => {
  await db.query(
    "INSERT INTO public.corporate_actions (symbol, kind, ex_date, split_new, split_old, source) VALUES ('TSLA','split','2026-11-04',5,1,'admin')"
  );
  const fetcher = (async (url: string) => {
    if (url.includes("/splits")) return Response.json({ data: { rows: [
      { symbol: "NVDA", ratio: "10 : 1", executionDate: "11/05/2026" },
      { symbol: "TSLA", ratio: "3 : 1", executionDate: "11/04/2026" },
      { symbol: "SOXX", ratio: "3:1", executionDate: "11/05/2026" }
    ] } });
    if (url.endsWith("date=2026-10-27")) return Response.json({ data: { calendar: { rows: [
      { symbol: "MU", dividend_Ex_Date: "10/27/2026", dividend_Rate: 0.115 },
      { symbol: "COKE", dividend_Ex_Date: "10/27/2026", dividend_Rate: 0.25 }
    ] } } });
    return Response.json({ data: { calendar: { rows: null } } });
  }) as unknown as typeof fetch;
  await new CorporateActionMonitor(db, fetcher).refresh(new Date("2026-10-26T14:00:00.000Z"));

  const { rows } = await db.query<{ symbol: string; kind: string; split_new: string | null; source: string }>(
    "SELECT symbol, kind, split_new::text, source FROM public.corporate_actions ORDER BY symbol"
  );
  expect(rows).toEqual([
    { symbol: "MU", kind: "cash_dividend", split_new: null, source: "nasdaq" },
    { symbol: "NVDA", kind: "split", split_new: "10.000000", source: "nasdaq" },
    { symbol: "TSLA", kind: "split", split_new: "5.000000", source: "admin" }
  ]);
  expect(await splitNear(db, "NVDA", new Date("2026-11-03T15:00:00.000Z"))).toBe(true);
  expect(await splitNear(db, "NVDA", new Date("2026-10-26T15:00:00.000Z"))).toBe(false);

  // A feed failure is recorded without dropping known actions.
  await new CorporateActionMonitor(db, (async () => new Response("down", { status: 503 })) as unknown as typeof fetch).refresh();
  const feed = await db.query<{ last_error: string }>("SELECT last_error FROM public.corporate_action_feed");
  expect(feed.rows[0]!.last_error).toContain("HTTP 503");
}, 60_000);

test("reports actions through the markets API using the latest pool price", async () => {
  const observedAt = new Date("2027-06-01T00:00:00.000Z");
  await db.query(
    `INSERT INTO public.pool_snapshots (market_id, observed_at, sqrt_price_x96, liquidity, usdg_balance, twap_price_usdg, spot_price_usdg, spot_twap_deviation_bps, oracle_tradable)
     SELECT id, $1, 1, 1, 1, 100, 100, 0, true FROM public.markets WHERE symbol='MSTR'`, [observedAt]
  );
  inserted.push(observedAt);
  await db.query("INSERT INTO public.corporate_actions (symbol, kind, ex_date, amount_usd, source) VALUES ('MSTR','cash_dividend','2026-11-02',10,'admin')");
  const view = await readCorporateAction(db, options, "mstr", new Date("2026-11-01T12:00:00.000Z"));
  expect(view).toMatchObject({ symbol: "MSTR", close_only: true, expected_price_change_pct: -10 });

  const app = express();
  app.use("/v1/markets", createMarketsRouter(db));
  const disabled = await request(app).get("/v1/markets/corporate-actions");
  expect(disabled.status).toBe(200);
  expect(disabled.body.enabled).toBe(false);
  expect(disabled.body.actions).toEqual([]);
}, 60_000);

test("walks the oracle toward moves beyond the 20% jump guard", () => {
  // A 10-for-1 split: $200 to $20 is published as 19% steps.
  expect(oracleCatchUp(e18(200), e18(20), e18(20), 1_900n)).toEqual({ twapE18: e18(162), spotE18: e18(162), stepping: true });
  expect(oracleCatchUp(e18(100), e18(150), e18(151), 1_900n)).toEqual({ twapE18: e18(119), spotE18: e18(119), stepping: true });
  // Inside the guard, and on first publication, the mark passes through.
  expect(oracleCatchUp(e18(100), e18(85), e18(84), 1_900n)).toEqual({ twapE18: e18(85), spotE18: e18(84), stepping: false });
  expect(oracleCatchUp(0n, e18(85), e18(84), 1_900n)).toEqual({ twapE18: e18(85), spotE18: e18(84), stepping: false });
});
