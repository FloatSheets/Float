import type { AppConfig } from "../config";
import { openingBell, type OpeningBell } from "./sessions";

const BPS = 10_000n;

export type OpeningBellOptions = { enabled: boolean; minutes: number; extraSpreadBps: number; ticketBps: number };

export type OpeningBellTerms = OpeningBell & { extraSpreadBps: number; ticketBps: number };

export function openingBellOptions(config: AppConfig): OpeningBellOptions {
  return {
    enabled: config.OPENING_BELL_ENABLED === "true",
    minutes: config.OPENING_BELL_MINUTES,
    extraSpreadBps: config.OPENING_BELL_EXTRA_SPREAD_BPS,
    ticketBps: config.OPENING_BELL_TICKET_BPS
  };
}

/**
 * Terms for new exposure during the opening bell. In the first minutes after
 * 9:30 ET the real stock reprices in its opening auction while the stock-token
 * pool and our TWAP mark lag behind it; a trader who sees the open can take a
 * stale price from the vault. Opens and increases pay a wider spread and are
 * limited to a smaller ticket until the window ends. Closes are unchanged.
 */
export function openingBellTerms(options: OpeningBellOptions, now: Date = new Date()): OpeningBellTerms | null {
  if (!options.enabled) return null;
  const bell = openingBell(now, options.minutes);
  return bell ? { ...bell, extraSpreadBps: options.extraSpreadBps, ticketBps: options.ticketBps } : null;
}

/** The bell-time ticket cap in USDG units for a market with `maxTicketUsdg`. */
export function openingBellTicket(maxTicketUsdg: bigint, terms: OpeningBellTerms): bigint {
  return maxTicketUsdg * BigInt(terms.ticketBps) / BPS;
}

export function openingBellTicketMessage(symbol: string, capUsdg: bigint, terms: OpeningBellTerms): string {
  const dollars = `$${(capUsdg / 1_000_000n).toLocaleString("en-US")}`;
  const ends = terms.endsAt.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return `During the opening bell, new ${symbol} positions are limited to ${dollars} per ticket. Full size returns at ${ends} ET; you can still close.`;
}
