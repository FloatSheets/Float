import type { Pool } from "pg";

import type { AppConfig } from "../config";
import { readActiveHalts } from "../markets/halts";
import { telegramRequest } from "../routes/telegram-alerts";
import { safeErrorMessage } from "../safe-error";

export type PennyState = "live" | "halt" | "pause" | "quiet";

/** A price pause must hold this long before it is announced, so a flicker is not news. */
const PAUSE_CONFIRM_MS = 120_000;

/**
 * Sorts a penny market's current condition into what a trader cares about:
 * halted (by its exchange or by Robinhood), paused by our price guards (a jump
 * away from the recent average, or sources disagreeing), live, or quiet
 * (warming up, or a quote that has not moved after hours, which is not news).
 */
export function classifyPennyState(input: { tradable: boolean | null; frozenReason: string | null; exchangeHalt: string | null }): { state: PennyState; reason: string | null } {
  if (input.exchangeHalt) return { state: "halt", reason: input.exchangeHalt };
  const reason = input.frozenReason ?? "";
  if (/halt|paused by Robinhood/i.test(reason)) return { state: "halt", reason };
  if (/from its .*average|sources disagree/i.test(reason)) return { state: "pause", reason };
  if (input.tradable) return { state: "live", reason: null };
  return { state: "quiet", reason: reason || null };
}

export function pennyAlertText(symbol: string, state: "live" | "halt" | "pause", reason: string | null): string {
  if (state === "halt") return `🛑 $${symbol} is halted: ${reason}.\nNew ${symbol} positions are paused on FloatSheets; closing stays open.`;
  if (state === "pause") return `⏸ $${symbol} paused on FloatSheets: ${reason}.\nNew positions wait until the price settles; closing stays open.`;
  return `▶️ $${symbol} is trading again on FloatSheets. New positions are open.`;
}

export async function setPennyAlertSubscription(database: Pool, chatId: string, enabled: boolean): Promise<string> {
  await database.query(
    `INSERT INTO public.penny_alert_subscriptions (telegram_chat_id, enabled) VALUES ($1,$2)
     ON CONFLICT (telegram_chat_id) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`, [chatId, enabled]
  );
  return enabled
    ? "Penny-stock alerts on. You'll get a message when a FloatSheets penny market is halted, paused by a price jump, or resumes. Use /pennyalerts off to stop."
    : "Penny-stock alerts off.";
}

/**
 * Broadcasts penny-market halts, price pauses and resumptions to Telegram
 * subscribers. Alerts fire on state changes only: a halt immediately, a pause
 * once it has held for two minutes, and a resumption only after an announced
 * halt or pause.
 */
export class PennyMarketAlerts {
  private running = false;
  constructor(private readonly database: Pool, private readonly config: AppConfig) {}

  async runOnce(now: Date = new Date()): Promise<void> {
    if (this.running || !this.config.TELEGRAM_BOT_TOKEN) return;
    this.running = true;
    try {
      const [markets, halts] = await Promise.all([
        this.database.query<{ symbol: string; oracle_tradable: boolean | null; frozen_reason: string | null }>(
          `SELECT m.symbol, s.oracle_tradable, s.frozen_reason FROM public.markets m LEFT JOIN LATERAL (
             SELECT oracle_tradable, frozen_reason FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
           ) s ON true
           WHERE 'copper' = ANY(m.releases) AND m.listed = TRUE AND m.status <> 'disabled' ORDER BY m.symbol`
        ),
        readActiveHalts(this.database)
      ]);
      for (const market of markets.rows) {
        const halt = halts.get(market.symbol);
        const observed = classifyPennyState({
          tradable: market.oracle_tradable, frozenReason: market.frozen_reason,
          exchangeHalt: halt ? `${halt.reason} on ${halt.listing_market}` : null
        });
        await this.track(market.symbol, observed.state, observed.reason, now);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "penny_alerts_failed", error: safeErrorMessage(error) }));
    } finally {
      this.running = false;
    }
  }

  private async track(symbol: string, state: PennyState, reason: string | null, now: Date): Promise<void> {
    const { rows } = await this.database.query<{ state: PennyState; since: Date; alerted: boolean; last_alerted_state: string | null }>(
      "SELECT state, since, alerted, last_alerted_state FROM public.penny_market_alert_state WHERE symbol=$1", [symbol]
    );
    const previous = rows[0];
    if (!previous || previous.state !== state) {
      await this.database.query(
        `INSERT INTO public.penny_market_alert_state (symbol, state, reason, since, alerted, last_alerted_state)
         VALUES ($1,$2,$3,$4,false,$5)
         ON CONFLICT (symbol) DO UPDATE SET state=EXCLUDED.state, reason=EXCLUDED.reason, since=EXCLUDED.since, alerted=false`,
        [symbol, state, reason, now, previous?.last_alerted_state ?? null]
      );
      // First sighting establishes a baseline; never announce the state a deploy found.
      if (!previous) {
        await this.database.query("UPDATE public.penny_market_alert_state SET alerted=true WHERE symbol=$1", [symbol]);
        return;
      }
    }
    const current = previous && previous.state === state ? previous : { state, since: now, alerted: false, last_alerted_state: previous?.last_alerted_state ?? null };
    if (current.alerted || state === "quiet") return;
    const heldMs = now.getTime() - current.since.getTime();
    const due = state === "halt"
      || (state === "pause" && heldMs >= PAUSE_CONFIRM_MS)
      || (state === "live" && (current.last_alerted_state === "halt" || current.last_alerted_state === "pause"));
    if (!due) {
      if (state === "live") await this.database.query("UPDATE public.penny_market_alert_state SET alerted=true WHERE symbol=$1", [symbol]);
      return;
    }
    await this.database.query(
      "UPDATE public.penny_market_alert_state SET alerted=true, last_alerted_state=$2 WHERE symbol=$1", [symbol, state]
    );
    await this.broadcast(pennyAlertText(symbol, state, reason));
  }

  private async broadcast(text: string): Promise<void> {
    const { rows } = await this.database.query<{ telegram_chat_id: string }>(
      "SELECT telegram_chat_id FROM public.penny_alert_subscriptions WHERE enabled = TRUE"
    );
    for (const row of rows) {
      try {
        await telegramRequest(this.config, "sendMessage", {
          chat_id: row.telegram_chat_id, text,
          reply_markup: { inline_keyboard: [[{ text: "Open penny stocks", url: new URL("/dashboard/", this.config.FRONTEND_URL).href }]] }
        });
      } catch (error) {
        console.warn(JSON.stringify({ event: "penny_alert_delivery_failed", error: safeErrorMessage(error) }));
      }
    }
  }
}
