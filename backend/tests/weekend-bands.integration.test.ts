import "dotenv/config";

import { afterEach, beforeEach, expect, test } from "bun:test";
import express from "express";
import request from "supertest";

import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { closedWindow } from "../src/markets/sessions";
import { bandedOracleMarks, clampToBand, decimalToE18, weekendBandRefusal, WeekendBands, type WeekendBandOptions } from "../src/markets/weekend-bands";
import { createMarketsRouter } from "../src/routes/markets";

const options: WeekendBandOptions = { enabled: true, maxBandBps: 500, shiftAfterSeconds: 3_600, maxShifts: 2 };
// Friday 23 October 2026: regular close 16:00 EDT = 20:00Z.
const FRIDAY_CLOSE = new Date("2026-10-23T20:00:00.000Z");
const SATURDAY = new Date("2026-10-24T15:00:00.000Z");
const inserted: Date[] = [];

async function snapshot(symbol: string, observedAt: Date, twap: string): Promise<void> {
  await db.query(
    `INSERT INTO public.pool_snapshots (market_id, observed_at, sqrt_price_x96, liquidity, usdg_balance, twap_price_usdg, spot_price_usdg, spot_twap_deviation_bps, oracle_tradable)
     SELECT id, $2, 1, 1, 1, $3, $3, 0, true FROM public.markets WHERE symbol=$1`, [symbol, observedAt, twap]
  );
  inserted.push(observedAt);
}

beforeEach(async () => {
  await migrate();
  await db.query("TRUNCATE public.weekend_bands");
});

afterEach(async () => {
  // These samples are dated in the future; never leave them as a market's latest price.
  if (inserted.length) await db.query("DELETE FROM public.pool_snapshots WHERE observed_at = ANY($1::timestamptz[])", [inserted]);
  inserted.length = 0;
});

test("finds the closure window across weekends, holidays and daylight saving", () => {
  expect(closedWindow(new Date("2026-10-22T15:00:00.000Z"))).toBeNull(); // Thursday session
  expect(closedWindow(new Date("2026-10-23T23:59:00.000Z"))).toBeNull(); // Friday 19:59 ET, after-hours
  expect(closedWindow(new Date("2026-10-28T02:00:00.000Z"))).toBeNull(); // Tuesday 22:00 ET overnight
  const weekend = closedWindow(SATURDAY)!;
  expect(weekend.anchorAt.toISOString()).toBe("2026-10-23T20:00:00.000Z");
  expect(weekend.closedAt.toISOString()).toBe("2026-10-24T00:00:00.000Z");
  expect(weekend.reopensAt.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  expect(closedWindow(new Date("2026-10-26T07:59:00.000Z"))).not.toBeNull(); // Monday 03:59 ET
  expect(closedWindow(new Date("2026-10-26T08:00:00.000Z"))).toBeNull(); // Monday 04:00 ET pre-market
  // Clocks fall back on Sunday 1 November: the close is EDT, the reopen is EST.
  const dst = closedWindow(new Date("2026-11-01T12:00:00.000Z"))!;
  expect(dst.anchorAt.toISOString()).toBe("2026-10-30T20:00:00.000Z");
  expect(dst.reopensAt.toISOString()).toBe("2026-11-02T09:00:00.000Z");
  // Thanksgiving: Wednesday evening through Friday's pre-market.
  const holiday = closedWindow(new Date("2026-11-26T17:00:00.000Z"))!;
  expect(holiday.anchorAt.toISOString()).toBe("2026-11-25T21:00:00.000Z");
  expect(holiday.reopensAt.toISOString()).toBe("2026-11-27T09:00:00.000Z");
});

test("anchors to the regular close and clamps marks inside the band", async () => {
  await snapshot("NVDA", new Date(FRIDAY_CLOSE.getTime() - 60_000), "200");
  await snapshot("NVDA", new Date(FRIDAY_CLOSE.getTime() + 600_000), "207"); // after-hours drift is ignored
  const bands = new WeekendBands(db, options);
  const band = (await bands.band("NVDA", SATURDAY))!;

  expect(band.bandBps).toBe(500); // min(1 / 5x leverage, 5% cap)
  expect(band.anchorPriceE18).toBe(decimalToE18("200"));
  expect(band.lowerE18).toBe(decimalToE18("190"));
  expect(band.upperE18).toBe(decimalToE18("210"));
  expect(clampToBand(decimalToE18("150"), band)).toBe(decimalToE18("190"));
  expect(clampToBand(decimalToE18("205"), band)).toBe(decimalToE18("205"));
  expect(await bands.band("NVDA", new Date("2026-10-22T15:00:00.000Z"))).toBeNull();

  // Without the cap, the width follows TradeXYZ's 1 / max leverage rule.
  await db.query("TRUNCATE public.weekend_bands");
  const wide = (await new WeekendBands(db, { ...options, maxBandBps: 5_000 }).band("NVDA", SATURDAY))!;
  expect(wide.bandBps).toBe(2_000);
}, 60_000);

test("shifts the band after a sustained move, up to the shift limit", async () => {
  await snapshot("NVDA", FRIDAY_CLOSE, "100");
  const bands = new WeekendBands(db, options);
  const at = (minutes: number) => new Date(SATURDAY.getTime() + minutes * 60_000);
  const pool = decimalToE18("130");

  await bands.band("NVDA", at(0), pool);
  expect((await bands.band("NVDA", at(59), pool))!.shiftsUp).toBe(0); // not yet sustained
  const first = (await bands.band("NVDA", at(60), pool))!;
  expect(first.shiftsUp).toBe(1);
  expect(first.upperE18).toBe(decimalToE18("110.25")); // center 105 ± 5%

  // A brief return inside the band resets persistence.
  await bands.band("NVDA", at(70), decimalToE18("108"));
  await bands.band("NVDA", at(80), pool);
  expect((await bands.band("NVDA", at(130), pool))!.shiftsUp).toBe(1);
  expect((await bands.band("NVDA", at(140), pool))!.shiftsUp).toBe(2);
  await bands.band("NVDA", at(150), pool);
  const capped = (await bands.band("NVDA", at(400), pool))!;
  expect(capped.shiftsUp).toBe(2); // limit reached: the band stops following
  expect(capped.centerPriceE18).toBe(decimalToE18("110.25"));
}, 60_000);

test("clamps published oracle marks on weekends and passes them through in session", async () => {
  await snapshot("PLTR", FRIDAY_CLOSE, "50");
  const bands = new WeekendBands(db, options);
  // A Sunday wick to $40 publishes at the band floor; spot is held too.
  const sunday = await bandedOracleMarks(bands, "PLTR", decimalToE18("40"), decimalToE18("39"), new Date("2026-10-25T18:00:00.000Z"));
  expect(sunday).toEqual({ twapE18: decimalToE18("47.5"), spotE18: decimalToE18("47.5"), clamped: true });
  // Monday pre-market: the band lifts and the pool price publishes as-is.
  const monday = await bandedOracleMarks(bands, "PLTR", decimalToE18("40"), decimalToE18("39"), new Date("2026-10-26T09:00:00.000Z"));
  expect(monday).toEqual({ twapE18: decimalToE18("40"), spotE18: decimalToE18("39"), clamped: false });
}, 60_000);

test("refuses new exposure only while the pool is outside the band", async () => {
  await snapshot("TSLA", FRIDAY_CLOSE, "400");
  const bands = new WeekendBands(db, options);
  await snapshot("TSLA", new Date(SATURDAY.getTime() - 60_000), "405");
  expect(await weekendBandRefusal(db, bands, "TSLA", SATURDAY)).toBeNull();

  await snapshot("TSLA", new Date(SATURDAY.getTime() - 30_000), "441");
  const refusal = await weekendBandRefusal(db, bands, "TSLA", SATURDAY);
  // 1 / 3x leverage is 33%; the 5% cap applies.
  expect(refusal).toBe("TSLA's underlying is closed until Mon 4:00 AM ET and its pool is trading above the weekend band ($380.00–$420.00). New positions reopen when the pool returns inside the band; you can still close.");
}, 60_000);

test("reports bands through the markets API", async () => {
  const app = express();
  app.use("/v1/markets", createMarketsRouter(db, 120, undefined, { ...options, enabled: false }));
  const disabled = await request(app).get("/v1/markets/weekend-bands");
  expect(disabled.status).toBe(200);
  expect(disabled.body).toEqual({ enabled: false, underlying_closed: false, reopens_at: null, bands: [] });

  const markets = await request(app).get("/v1/markets");
  expect(markets.body.markets.every((row: { weekend_band: unknown }) => row.weekend_band === null)).toBe(true);
}, 60_000);
