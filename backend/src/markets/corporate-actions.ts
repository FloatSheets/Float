import type { Pool } from "pg";

import type { AppConfig } from "../config";
import { safeErrorMessage } from "../safe-error";
import { addDays, easternAt, easternParts, isTradingDay } from "./sessions";

const SPLITS_URL = "https://api.nasdaq.com/api/calendar/splits";
const DIVIDENDS_URL = "https://api.nasdaq.com/api/calendar/dividends";
const FETCH_TIMEOUT_MS = 15_000;
/** How far ahead to read the dividend calendar, in calendar days. */
const DIVIDEND_LOOKAHEAD_DAYS = 10;
/** A notice appears this many calendar days before a regular dividend. */
const DIVIDEND_NOTICE_DAYS = 3;

export type CorporateActionOptions = {
  enabled: boolean;
  /** Close-only lead time before a split. Matches the 7-day maximum position duration. */
  splitCloseOnlyDays: number;
  /** Dividends at or above this share of the price make the market close-only around the ex-date. */
  largeDividendBps: number;
};

export function corporateActionOptions(config: AppConfig): CorporateActionOptions {
  return {
    enabled: config.CORPORATE_ACTIONS_ENABLED === "true",
    splitCloseOnlyDays: config.SPLIT_CLOSE_ONLY_DAYS,
    largeDividendBps: config.LARGE_DIVIDEND_BPS
  };
}

export type CorporateAction = {
  symbol: string;
  kind: "split" | "cash_dividend";
  exDate: string;
  splitNew: number | null;
  splitOld: number | null;
  amountUsd: number | null;
};

export type CorporateActionView = {
  symbol: string;
  kind: "split" | "cash_dividend";
  ex_date: string;
  ratio: string | null;
  amount_usd: string | null;
  /** Expected mechanical price change on the ex-date, as a percentage. */
  expected_price_change_pct: number | null;
  close_only: boolean;
  close_only_from: string | null;
  close_only_until: string | null;
  summary: string;
};

/** Parses Nasdaq split ratios: "10 : 1" is a 10-for-1 split, "1 : 10" a 1-for-10 reverse split. */
export function parseSplitRatio(ratio: string): { splitNew: number; splitOld: number } | null {
  const match = ratio.match(/^\s*(\d+(?:\.\d+)?)\s*[:\-/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const splitNew = Number(match[1]);
  const splitOld = Number(match[2]);
  return splitNew > 0 && splitOld > 0 && splitNew !== splitOld ? { splitNew, splitOld } : null;
}

function isoDate(usDate: string): string | null {
  const match = usDate.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}` : null;
}

function previousTradingDay(date: string): string {
  let day = addDays(date, -1);
  while (!isTradingDay(day)) day = addDays(day, -1);
  return day;
}

function longDate(date: string): string {
  return easternAt(date, "12:00:00").toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
}

/**
 * The trading policy for an action at `now`. Perpetual positions cannot be
 * rescaled on-chain for a split, and perps pay no dividends, so the market
 * stops taking new exposure before either would hit open positions.
 */
export function corporateActionPolicy(
  action: CorporateAction, now: Date, options: CorporateActionOptions, priceUsd: number | null
): CorporateActionView | null {
  const ratio = action.splitNew && action.splitOld ? `${action.splitNew}-for-${action.splitOld}` : null;
  if (action.kind === "split") {
    // Positions opened before this point expire (7-day maximum) before the
    // ex-date; the keeper closes them. New exposure resumes after the split day.
    const from = new Date(easternAt(action.exDate, "04:00:00").getTime() - options.splitCloseOnlyDays * 86_400_000);
    const until = easternAt(action.exDate, "20:00:00");
    if (now < new Date(from.getTime() - 3 * 86_400_000) || now >= until) return null;
    const change = (action.splitOld! / action.splitNew! - 1) * 100;
    const closeOnly = now >= from;
    const reverse = action.splitNew! < action.splitOld!;
    return {
      symbol: action.symbol, kind: "split", ex_date: action.exDate, ratio, amount_usd: null,
      expected_price_change_pct: Math.round(change * 100) / 100,
      close_only: closeOnly, close_only_from: from.toISOString(), close_only_until: until.toISOString(),
      summary: `${action.symbol} ${reverse ? "reverse " : ""}splits ${ratio} on ${longDate(action.exDate)}. Positions cannot be resized for a split, so ${action.symbol} is close-only from ${longDate(easternParts(from).date)} through the split day; open positions reach their 7-day limit and close before it.`
    };
  }
  const amount = action.amountUsd!;
  const yieldBps = priceUsd && priceUsd > 0 ? (amount / priceUsd) * 10_000 : null;
  const large = yieldBps !== null && yieldBps >= options.largeDividendBps;
  const from = easternAt(previousTradingDay(action.exDate), "20:00:00");
  const until = easternAt(action.exDate, "09:40:00");
  const noticeFrom = easternAt(addDays(action.exDate, -DIVIDEND_NOTICE_DAYS), "00:00:00");
  if (now < noticeFrom || now >= until) return null;
  const change = priceUsd && priceUsd > 0 ? -(amount / priceUsd) * 100 : null;
  return {
    symbol: action.symbol, kind: "cash_dividend", ex_date: action.exDate, ratio: null, amount_usd: amount.toFixed(4),
    expected_price_change_pct: change === null ? null : Math.round(change * 100) / 100,
    close_only: large && now >= from,
    close_only_from: large ? from.toISOString() : null,
    close_only_until: large ? until.toISOString() : null,
    summary: large
      ? `${action.symbol} goes ex-dividend $${amount.toFixed(2)} on ${longDate(action.exDate)} (about ${(yieldBps! / 100).toFixed(1)}% of its price). Perps do not receive dividends, so ${action.symbol} is close-only from the evening before until 9:40 AM ET on the ex-date.`
      : `${action.symbol} goes ex-dividend $${amount.toFixed(2)} on ${longDate(action.exDate)}. Expect the price to open about that much lower; perps do not receive dividends, so longs absorb the drop and shorts gain it.`
  };
}

export function corporateActionRefusal(view: CorporateActionView): string {
  return `${view.summary} You can still close.`;
}

/** Active or upcoming actions for each listed market, at most one per market (the earliest). */
export async function readCorporateActions(
  database: Pool, options: CorporateActionOptions, now: Date = new Date()
): Promise<Map<string, CorporateActionView>> {
  const views = new Map<string, CorporateActionView>();
  if (!options.enabled) return views;
  const today = easternParts(now).date;
  const { rows } = await database.query<{
    symbol: string; kind: "split" | "cash_dividend"; ex_date: string; split_new: string | null; split_old: string | null;
    amount_usd: string | null; price: string | null;
  }>(
    `SELECT a.symbol, a.kind, a.ex_date::text, a.split_new::text, a.split_old::text, a.amount_usd::text, s.twap_price_usdg::text AS price
     FROM public.corporate_actions a JOIN public.markets m ON m.symbol=a.symbol
     LEFT JOIN LATERAL (
       SELECT twap_price_usdg FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
     ) s ON true
     WHERE a.ex_date >= $1::date AND a.ex_date <= $1::date + $2::int
     ORDER BY a.ex_date, a.kind`,
    [today, options.splitCloseOnlyDays + 4]
  );
  for (const row of rows) {
    if (views.has(row.symbol)) continue;
    const view = corporateActionPolicy({
      symbol: row.symbol, kind: row.kind, exDate: row.ex_date,
      splitNew: row.split_new === null ? null : Number(row.split_new), splitOld: row.split_old === null ? null : Number(row.split_old),
      amountUsd: row.amount_usd === null ? null : Number(row.amount_usd)
    }, now, options, row.price === null ? null : Number(row.price));
    if (view) views.set(row.symbol, view);
  }
  return views;
}

export async function readCorporateAction(
  database: Pool, options: CorporateActionOptions, symbol: string, now: Date = new Date()
): Promise<CorporateActionView | null> {
  return (await readCorporateActions(database, options, now)).get(symbol.toUpperCase()) ?? null;
}

/** True when a split's ex-date is within `days` of now: its price move is expected, not manipulation. */
export async function splitNear(database: Pool, symbol: string, now: Date, days = 3): Promise<boolean> {
  const today = easternParts(now).date;
  const { rowCount } = await database.query(
    `SELECT 1 FROM public.corporate_actions WHERE symbol=$1 AND kind='split'
     AND ex_date BETWEEN $2::date - $3::int AND $2::date + $3::int LIMIT 1`,
    [symbol.toUpperCase(), today, days]
  );
  return Boolean(rowCount);
}

type NasdaqSplitRow = { symbol?: string; ratio?: string; executionDate?: string };
type NasdaqDividendRow = { symbol?: string; dividend_Ex_Date?: string; dividend_Rate?: number | string };

/** Mirrors the Nasdaq split and dividend calendars for listed markets. */
export class CorporateActionMonitor {
  constructor(private readonly database: Pool, private readonly fetcher: typeof fetch = fetch) {}

  private async json<T>(url: string): Promise<T> {
    const response = await this.fetcher(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (FloatSheets corporate action monitor)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`corporate action calendar returned HTTP ${response.status}`);
    return await response.json() as T;
  }

  async refresh(now: Date = new Date()): Promise<void> {
    try {
      const { rows: markets } = await this.database.query<{ symbol: string }>("SELECT symbol FROM public.markets WHERE listed = TRUE");
      const listed = new Set(markets.map((row) => row.symbol.toUpperCase()));
      const actions: CorporateAction[] = [];

      const splits = await this.json<{ data?: { rows?: NasdaqSplitRow[] | null } }>(SPLITS_URL);
      for (const row of splits.data?.rows ?? []) {
        const symbol = row.symbol?.trim().toUpperCase();
        const exDate = row.executionDate ? isoDate(row.executionDate) : null;
        const ratio = row.ratio ? parseSplitRatio(row.ratio) : null;
        if (symbol && listed.has(symbol) && exDate && ratio) actions.push({ symbol, kind: "split", exDate, ...ratio, amountUsd: null });
      }

      const today = easternParts(now).date;
      for (let offset = 0; offset <= DIVIDEND_LOOKAHEAD_DAYS; offset++) {
        const date = addDays(today, offset);
        if (!isTradingDay(date)) continue;
        const dividends = await this.json<{ data?: { calendar?: { rows?: NasdaqDividendRow[] | null } } }>(`${DIVIDENDS_URL}?date=${date}`);
        for (const row of dividends.data?.calendar?.rows ?? []) {
          const symbol = row.symbol?.trim().toUpperCase();
          const exDate = row.dividend_Ex_Date ? isoDate(row.dividend_Ex_Date) : null;
          const amount = Number(row.dividend_Rate);
          if (symbol && listed.has(symbol) && exDate && Number.isFinite(amount) && amount > 0) {
            actions.push({ symbol, kind: "cash_dividend", exDate, splitNew: null, splitOld: null, amountUsd: amount });
          }
        }
      }

      for (const action of actions) {
        await this.database.query(
          `INSERT INTO public.corporate_actions (symbol, kind, ex_date, split_new, split_old, amount_usd, source, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,'nasdaq',$7)
           ON CONFLICT (symbol, kind, ex_date) DO UPDATE SET split_new=EXCLUDED.split_new, split_old=EXCLUDED.split_old,
             amount_usd=EXCLUDED.amount_usd, last_seen_at=EXCLUDED.last_seen_at
           WHERE public.corporate_actions.source='nasdaq'`,
          [action.symbol, action.kind, action.exDate, action.splitNew, action.splitOld, action.amountUsd, now]
        );
      }
      await this.database.query(
        `INSERT INTO public.corporate_action_feed (id, last_success_at, last_error, updated_at) VALUES (true, $1, NULL, now())
         ON CONFLICT (id) DO UPDATE SET last_success_at=EXCLUDED.last_success_at, last_error=NULL, updated_at=now()`, [now]
      );
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.database.query(
        `INSERT INTO public.corporate_action_feed (id, last_error, updated_at) VALUES (true, $1, now())
         ON CONFLICT (id) DO UPDATE SET last_error=EXCLUDED.last_error, updated_at=now()`, [message]
      );
      console.error(JSON.stringify({ event: "corporate_action_feed_failed", error: message }));
    }
  }
}
