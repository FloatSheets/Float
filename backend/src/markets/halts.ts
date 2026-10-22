import type { Pool } from "pg";

import { safeErrorMessage } from "../safe-error";

export const NASDAQ_HALT_FEED_URL = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts";
const FETCH_TIMEOUT_MS = 10_000;
/** A feed older than this is reported as stale; known halts stay in force. */
export const HALT_FEED_STALE_SECONDS = 600;

/** Nasdaq Trader halt reason codes, in the words a trader would use. */
const REASONS: Record<string, string> = {
  T1: "news pending", T2: "news released", T3: "news and resumption times", T5: "single-stock trading pause",
  T6: "extraordinary market activity", T7: "quotation-only period", T8: "ETF component halt", T12: "additional information requested",
  H4: "non-compliance", H9: "not current in filings", H10: "SEC trading suspension", H11: "regulatory concern",
  O1: "operations halt", IPO1: "IPO not yet trading", M1: "corporate action", M2: "quotation not available",
  LUDP: "volatility trading pause", LUDS: "volatility pause straddle condition",
  MWC0: "market-wide circuit breaker carried over", MWC1: "market-wide circuit breaker level 1",
  MWC2: "market-wide circuit breaker level 2", MWC3: "market-wide circuit breaker level 3", MWCQ: "market-wide circuit breaker resumption"
};

export function haltReason(code: string): string {
  return REASONS[code] ?? `halt code ${code}`;
}

/** Market-wide circuit breakers halt every listed stock, not one issue. */
export function isMarketWideHalt(code: string): boolean {
  return /^MWC[0-3]$/.test(code);
}

export type FeedHalt = {
  symbol: string;
  haltedAt: Date;
  listingMarket: string;
  reasonCode: string;
  resumptionTradeAt: Date | null;
};

export type ActiveHalt = {
  symbol: string;
  listing_market: string;
  reason_code: string;
  reason: string;
  halted_at: string;
  resumption_trade_at: string | null;
};

function tag(item: string, name: string): string {
  const match = item.match(new RegExp(`<ndaq:${name}>([^<]*)</ndaq:${name}>`));
  return match?.[1]?.trim() ?? "";
}

function offsetMinutes(instant: Date): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
    .formatToParts(instant).find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
  const match = label.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return -300;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/** Converts a feed date ("MM/DD/YYYY") and Eastern time ("HH:MM:SS.sss") to UTC. */
export function easternToUtc(date: string, time: string): Date | null {
  const day = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const clock = time.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!day || !clock) return null;
  const [month, dayOfMonth, hour, minute, second] = [Number(day[1]), Number(day[2]), Number(clock[1]), Number(clock[2]), Number(clock[3])];
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const wall = Date.UTC(Number(day[3]), Number(day[1]) - 1, Number(day[2]), Number(clock[1]), Number(clock[2]), Number(clock[3]), Number((clock[4] ?? "0").padEnd(3, "0")));
  // Resolve the Eastern offset at the target instant, then re-check once so
  // times on a daylight-saving boundary land on the right side of it.
  let utc = wall - offsetMinutes(new Date(wall)) * 60_000;
  utc = wall - offsetMinutes(new Date(utc)) * 60_000;
  return new Date(utc);
}

export function parseHaltFeed(xml: string): FeedHalt[] {
  const halts: FeedHalt[] = [];
  for (const [item] of xml.matchAll(/<item>[\s\S]*?<\/item>/g)) {
    const reasonCode = tag(item, "ReasonCode").toUpperCase();
    const symbol = tag(item, "IssueSymbol").toUpperCase();
    const haltedAt = easternToUtc(tag(item, "HaltDate"), tag(item, "HaltTime"));
    if (!reasonCode || !haltedAt || (!symbol && !isMarketWideHalt(reasonCode))) continue;
    const resumptionDate = tag(item, "ResumptionDate");
    const resumptionTime = tag(item, "ResumptionTradeTime");
    halts.push({
      symbol,
      haltedAt,
      listingMarket: tag(item, "Market") || "US exchange",
      reasonCode,
      resumptionTradeAt: resumptionDate && resumptionTime ? easternToUtc(resumptionDate, resumptionTime) : null
    });
  }
  return halts;
}

/**
 * Mirrors listing-exchange halts for FloatSheets markets. While the real stock
 * cannot trade, its stock-token pool and our oracle cannot discover a fair
 * price, so new exposure is refused and only closes are quoted.
 */
export class HaltMonitor {
  constructor(
    private readonly database: Pool,
    private readonly feedUrl: string = NASDAQ_HALT_FEED_URL,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async refresh(now: Date = new Date()): Promise<void> {
    let halts: FeedHalt[];
    try {
      const response = await this.fetcher(this.feedUrl, {
        headers: { accept: "application/rss+xml, application/xml", "user-agent": "FloatSheets halt monitor" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`halt feed returned HTTP ${response.status}`);
      const body = await response.text();
      if (!body.includes("<rss")) throw new Error("halt feed did not return RSS");
      halts = parseHaltFeed(body);
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.database.query(
        `INSERT INTO public.exchange_halt_feed (id, last_error, updated_at) VALUES (true, $1, now())
         ON CONFLICT (id) DO UPDATE SET last_error=EXCLUDED.last_error, updated_at=now()`, [message]
      );
      console.error(JSON.stringify({ event: "halt_feed_failed", error: message }));
      return;
    }

    const { rows } = await this.database.query<{ symbol: string }>("SELECT symbol FROM public.markets");
    const listed = new Set(rows.map((row) => row.symbol.toUpperCase()));
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // Only halts in the latest successful read can be active.
      await client.query("UPDATE public.exchange_halts SET active=false WHERE active");
      for (const halt of halts) {
        const symbols = isMarketWideHalt(halt.reasonCode) ? [...listed] : listed.has(halt.symbol) ? [halt.symbol] : [];
        const active = halt.resumptionTradeAt === null || halt.resumptionTradeAt > now;
        for (const symbol of symbols) {
          await client.query(
            `INSERT INTO public.exchange_halts (symbol, halted_at, listing_market, reason_code, resumption_trade_at, active, last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (symbol, halted_at) DO UPDATE SET listing_market=EXCLUDED.listing_market, reason_code=EXCLUDED.reason_code,
               resumption_trade_at=EXCLUDED.resumption_trade_at, active=EXCLUDED.active, last_seen_at=EXCLUDED.last_seen_at`,
            [symbol, halt.haltedAt, halt.listingMarket, halt.reasonCode, halt.resumptionTradeAt, active, now]
          );
        }
      }
      await client.query(
        `INSERT INTO public.exchange_halt_feed (id, last_success_at, last_error, updated_at) VALUES (true, $1, NULL, now())
         ON CONFLICT (id) DO UPDATE SET last_success_at=EXCLUDED.last_success_at, last_error=NULL, updated_at=now()`, [now]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Current halts keyed by symbol. A scheduled resumption ends a halt on time. */
export async function readActiveHalts(database: Pool): Promise<Map<string, ActiveHalt>> {
  const { rows } = await database.query<{
    symbol: string; listing_market: string; reason_code: string; halted_at: Date; resumption_trade_at: Date | null;
  }>(
    `SELECT DISTINCT ON (symbol) symbol, listing_market, reason_code, halted_at, resumption_trade_at
     FROM public.exchange_halts
     WHERE active AND (resumption_trade_at IS NULL OR resumption_trade_at > now())
     ORDER BY symbol, halted_at DESC`
  );
  return new Map(rows.map((row) => [row.symbol, {
    symbol: row.symbol,
    listing_market: row.listing_market,
    reason_code: row.reason_code,
    reason: haltReason(row.reason_code),
    halted_at: row.halted_at.toISOString(),
    resumption_trade_at: row.resumption_trade_at?.toISOString() ?? null
  }]));
}

export async function readActiveHalt(database: Pool, symbol: string): Promise<ActiveHalt | null> {
  return (await readActiveHalts(database)).get(symbol.toUpperCase()) ?? null;
}

export function haltMessage(halt: ActiveHalt): string {
  return `${halt.symbol} is halted on ${halt.listing_market} (${halt.reason}). New positions are paused until the exchange resumes trading; you can still close.`;
}
