import type { Pool } from "pg";

import type { AppConfig } from "../config";
import { closedWindow, type ClosedWindow } from "./sessions";

const BPS = 10_000n;
const E18_DECIMALS = 18;
/** The band anchors to a snapshot no older than this before the close. */
const ANCHOR_LOOKBACK_SECONDS = 6 * 60 * 60;

export type WeekendBandOptions = {
  enabled: boolean;
  maxBandBps: number;
  shiftAfterSeconds: number;
  maxShifts: number;
};

export type WeekendBand = {
  symbol: string;
  window: ClosedWindow;
  anchorPriceE18: bigint;
  centerPriceE18: bigint;
  lowerE18: bigint;
  upperE18: bigint;
  bandBps: number;
  shiftsUp: number;
  shiftsDown: number;
  outside: "above" | "below" | null;
  outsideSince: Date | null;
};

export type WeekendBandView = {
  symbol: string;
  anchor_at: string;
  closed_at: string;
  reopens_at: string;
  anchor_price_usdg: string;
  center_price_usdg: string;
  lower_usdg: string;
  upper_usdg: string;
  band_bps: number;
  shifts_up: number;
  shifts_down: number;
  max_shifts: number;
  pool_price_usdg: string | null;
  pool_outside: "above" | "below" | null;
};

export function decimalToE18(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(E18_DECIMALS, "0").slice(0, E18_DECIMALS)}`);
}

export function e18ToDecimal(value: bigint, places = 6): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(E18_DECIMALS, "0").slice(0, places);
  return `${whole}.${fraction}`;
}

export function clampToBand(priceE18: bigint, band: Pick<WeekendBand, "lowerE18" | "upperE18">): bigint {
  return priceE18 < band.lowerE18 ? band.lowerE18 : priceE18 > band.upperE18 ? band.upperE18 : priceE18;
}

export function bandSide(priceE18: bigint, band: Pick<WeekendBand, "lowerE18" | "upperE18">): "above" | "below" | null {
  return priceE18 > band.upperE18 ? "above" : priceE18 < band.lowerE18 ? "below" : null;
}

export function weekendBandOptions(config: AppConfig): WeekendBandOptions {
  return {
    enabled: config.WEEKEND_BANDS_ENABLED === "true",
    maxBandBps: config.WEEKEND_BAND_MAX_BPS,
    shiftAfterSeconds: config.WEEKEND_BAND_SHIFT_AFTER_SECONDS,
    maxShifts: config.WEEKEND_BAND_MAX_SHIFTS
  };
}

type BandRow = {
  anchor_price_e18: string; center_price_e18: string; band_bps: number; shifts_up: number; shifts_down: number;
  outside_direction: "above" | "below" | null; outside_since: Date | null;
};

/**
 * Weekend discovery bands. While the listing exchange is closed, a stock-token
 * pool is the only price source and thin weekend liquidity lets one wallet
 * drag it far from fair value. Each market is held inside a band around the
 * last regular close: new exposure pauses while the pool trades outside it,
 * and the published oracle mark is clamped to it, so a weekend wick cannot
 * liquidate anyone. A move that persists (real news) shifts the band one step,
 * up to a fixed number of times per direction.
 */
export class WeekendBands {
  constructor(private readonly database: Pool, private readonly options: WeekendBandOptions) {}

  /**
   * Returns the active band for a market, or null while its underlying can
   * trade. Passing the current pool TWAP advances the persistence and shift
   * state; read-only callers omit it.
   */
  async band(symbol: string, now: Date = new Date(), poolPriceE18?: bigint): Promise<WeekendBand | null> {
    if (!this.options.enabled) return null;
    const window = closedWindow(now);
    if (!window) return null;
    const normalized = symbol.toUpperCase();
    let row = await this.load(normalized, window);
    if (!row) {
      const created = await this.create(normalized, window);
      if (!created) return null;
      row = created;
    }
    if (poolPriceE18 !== undefined) row = await this.observe(normalized, window, row, poolPriceE18, now);
    return this.toBand(normalized, window, row);
  }

  private toBand(symbol: string, window: ClosedWindow, row: BandRow): WeekendBand {
    const center = BigInt(row.center_price_e18);
    const bps = BigInt(row.band_bps);
    return {
      symbol, window,
      anchorPriceE18: BigInt(row.anchor_price_e18),
      centerPriceE18: center,
      lowerE18: center * (BPS - bps) / BPS,
      upperE18: center * (BPS + bps) / BPS,
      bandBps: row.band_bps,
      shiftsUp: row.shifts_up,
      shiftsDown: row.shifts_down,
      outside: row.outside_direction,
      outsideSince: row.outside_since
    };
  }

  private async load(symbol: string, window: ClosedWindow): Promise<BandRow | null> {
    const { rows } = await this.database.query<BandRow>(
      `SELECT anchor_price_e18::text, center_price_e18::text, band_bps, shifts_up, shifts_down, outside_direction, outside_since
       FROM public.weekend_bands WHERE symbol=$1 AND anchor_at=$2`, [symbol, window.anchorAt]
    );
    return rows[0] ?? null;
  }

  private async create(symbol: string, window: ClosedWindow): Promise<BandRow | null> {
    // Anchor to the last sample at the regular close; if the monitor missed it,
    // use the first sample after the close (before after-hours ended).
    // Without either, no band can be set.
    const { rows } = await this.database.query<{ twap_price_usdg: string; max_leverage: string }>(
      `SELECT s.twap_price_usdg::text, m.max_leverage::text FROM public.markets m
       JOIN public.pool_snapshots s ON s.market_id=m.id
       WHERE m.symbol=$1 AND s.twap_price_usdg IS NOT NULL
         AND s.observed_at <= $3 AND s.observed_at >= $2::timestamptz - make_interval(secs => $4::double precision)
       ORDER BY (s.observed_at <= $2) DESC,
                CASE WHEN s.observed_at <= $2 THEN s.observed_at END DESC,
                s.observed_at ASC
       LIMIT 1`,
      [symbol, window.anchorAt, window.closedAt, ANCHOR_LOOKBACK_SECONDS]
    );
    const anchor = rows[0];
    if (!anchor) {
      console.warn(JSON.stringify({ event: "weekend_band_unanchored", market: symbol, anchor_at: window.anchorAt.toISOString() }));
      return null;
    }
    const leverage = Number(anchor.max_leverage);
    const leverageBps = Number.isFinite(leverage) && leverage >= 1 ? Math.floor(10_000 / leverage) : 10_000;
    const bandBps = Math.max(1, Math.min(this.options.maxBandBps, leverageBps, 9_999));
    const anchorE18 = decimalToE18(anchor.twap_price_usdg).toString();
    await this.database.query(
      `INSERT INTO public.weekend_bands (symbol, anchor_at, anchor_price_e18, center_price_e18, band_bps)
       VALUES ($1,$2,$3,$3,$4) ON CONFLICT (symbol, anchor_at) DO NOTHING`,
      [symbol, window.anchorAt, anchorE18, bandBps]
    );
    return this.load(symbol, window);
  }

  private async observe(symbol: string, window: ClosedWindow, row: BandRow, poolPriceE18: bigint, now: Date): Promise<BandRow> {
    const band = this.toBand(symbol, window, row);
    const side = bandSide(poolPriceE18, band);
    if (side === null) {
      if (row.outside_direction === null) return row;
      await this.database.query(
        "UPDATE public.weekend_bands SET outside_direction=NULL, outside_since=NULL, updated_at=now() WHERE symbol=$1 AND anchor_at=$2",
        [symbol, window.anchorAt]
      );
      return { ...row, outside_direction: null, outside_since: null };
    }
    if (row.outside_direction !== side || !row.outside_since) {
      await this.database.query(
        "UPDATE public.weekend_bands SET outside_direction=$3, outside_since=$4, updated_at=now() WHERE symbol=$1 AND anchor_at=$2",
        [symbol, window.anchorAt, side, now]
      );
      return { ...row, outside_direction: side, outside_since: now };
    }
    const persisted = (now.getTime() - row.outside_since.getTime()) / 1_000 >= this.options.shiftAfterSeconds;
    const shifts = side === "above" ? row.shifts_up : row.shifts_down;
    if (!persisted || shifts >= this.options.maxShifts) return row;
    // The move has held for the full window: treat it as price discovery and
    // move the band one step toward it. Persistence restarts from the new band.
    const bps = BigInt(row.band_bps);
    const center = BigInt(row.center_price_e18);
    const nextCenter = side === "above" ? center * (BPS + bps) / BPS : center * (BPS - bps) / BPS;
    await this.database.query(
      `UPDATE public.weekend_bands SET center_price_e18=$3, shifts_up=shifts_up+$4, shifts_down=shifts_down+$5,
         outside_direction=NULL, outside_since=NULL, updated_at=now() WHERE symbol=$1 AND anchor_at=$2`,
      [symbol, window.anchorAt, nextCenter.toString(), side === "above" ? 1 : 0, side === "below" ? 1 : 0]
    );
    console.log(JSON.stringify({ event: "weekend_band_shifted", market: symbol, direction: side, center_price_usdg: e18ToDecimal(nextCenter) }));
    return {
      ...row, center_price_e18: nextCenter.toString(),
      shifts_up: row.shifts_up + (side === "above" ? 1 : 0), shifts_down: row.shifts_down + (side === "below" ? 1 : 0),
      outside_direction: null, outside_since: null
    };
  }
}

export function weekendBandView(band: WeekendBand, poolPriceE18: bigint | null, maxShifts: number): WeekendBandView {
  return {
    symbol: band.symbol,
    anchor_at: band.window.anchorAt.toISOString(),
    closed_at: band.window.closedAt.toISOString(),
    reopens_at: band.window.reopensAt.toISOString(),
    anchor_price_usdg: e18ToDecimal(band.anchorPriceE18),
    center_price_usdg: e18ToDecimal(band.centerPriceE18),
    lower_usdg: e18ToDecimal(band.lowerE18),
    upper_usdg: e18ToDecimal(band.upperE18),
    band_bps: band.bandBps,
    shifts_up: band.shiftsUp,
    shifts_down: band.shiftsDown,
    max_shifts: maxShifts,
    pool_price_usdg: poolPriceE18 === null ? null : e18ToDecimal(poolPriceE18),
    pool_outside: poolPriceE18 === null ? null : bandSide(poolPriceE18, band)
  };
}

/**
 * The oracle mark to publish. While the underlying is closed, both the TWAP
 * and spot legs are held inside the band; the pool TWAP still drives the
 * band's persistence and shift state.
 */
export async function bandedOracleMarks(
  bands: WeekendBands, symbol: string, twapE18: bigint, spotE18: bigint, now: Date = new Date()
): Promise<{ twapE18: bigint; spotE18: bigint; clamped: boolean }> {
  const band = await bands.band(symbol, now, twapE18);
  if (!band) return { twapE18, spotE18, clamped: false };
  const twap = clampToBand(twapE18, band);
  const spot = clampToBand(spotE18, band);
  return { twapE18: twap, spotE18: spot, clamped: twap !== twapE18 || spot !== spotE18 };
}

/** Latest pool TWAP for a market as an 18-decimal integer. */
export async function readPoolPriceE18(database: Pool, symbol: string): Promise<bigint | null> {
  const { rows } = await database.query<{ twap_price_usdg: string | null }>(
    `SELECT s.twap_price_usdg::text FROM public.markets m JOIN public.pool_snapshots s ON s.market_id=m.id
     WHERE m.symbol=$1 ORDER BY s.observed_at DESC LIMIT 1`, [symbol.toUpperCase()]
  );
  const price = rows[0]?.twap_price_usdg;
  return price ? decimalToE18(price) : null;
}

/** Why new exposure is refused, or null when the band allows it. */
export async function weekendBandRefusal(database: Pool, bands: WeekendBands, symbol: string, now: Date = new Date()): Promise<string | null> {
  const band = await bands.band(symbol, now);
  if (!band) return null;
  const pool = await readPoolPriceE18(database, symbol);
  if (pool === null) return `${band.symbol}'s underlying is closed and no pool price is available. New positions reopen when trading resumes; you can still close.`;
  const side = bandSide(pool, band);
  if (!side) return null;
  const reopens = band.window.reopensAt.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  return `${band.symbol}'s underlying is closed until ${reopens} ET and its pool is trading ${side} the weekend band ($${e18ToDecimal(band.lowerE18, 2)}–$${e18ToDecimal(band.upperE18, 2)}). New positions reopen when the pool returns inside the band; you can still close.`;
}
