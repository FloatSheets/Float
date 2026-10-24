import type { Pool } from "pg";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address } from "viem";

import { contractConfigForVersion, isCopperConfigured, type AppConfig } from "../config";
import { marketId } from "../chain/protocol";
import { readClearingMarket } from "../chain/protocol-read";
import type { RpcTransport } from "../chain/rpc";
import { telegramRequest } from "../routes/telegram-alerts";
import { safeErrorMessage } from "../safe-error";
import { closedWindow, currentOrNextClosedWindow, type ClosedWindow } from "./sessions";

const ownerAbi = parseAbi(["function owner() view returns (address)"]);
const E18 = 10n ** 18n;

export type ClosurePhase = "open" | "closure_due" | "closed";
export type ClosureAction = "apply_closure" | "restore_launch";

export type ClosureState = {
  phase: ClosurePhase;
  profile_due_at: string | null;
  closes_at: string | null;
  reopens_at: string | null;
  closure_max_leverage: number;
  markets: { symbol: string; max_leverage: number }[];
  action: ClosureAction | null;
  summary: string | null;
  command: string | null;
};

function etTime(date: Date): string {
  return date.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";
}

/** The most recent closure window that has already reopened, scanning back up to nine days. */
function previousClosedWindow(now: Date): ClosedWindow | null {
  for (let hour = 1; hour <= 24 * 9; hour++) {
    const window = closedWindow(new Date(now.getTime() - hour * 3_600_000));
    if (window && window.reopensAt <= now) return window;
  }
  return null;
}

/**
 * Weekend closure autopilot for Copper. Penny names gap 20-40% over a weekend,
 * so before each closure the owner switches every Copper market to the 3x
 * closure profile and switches back after the reopen. Those are owner
 * transactions, so they are never automated server-side; instead this watches
 * the on-chain leverage against the NYSE calendar, reminds the owner on the
 * Telegram account linked to the owner wallet, and reports a missed switch on
 * the public status page.
 */
export class CopperClosureWatch {
  private cached: { at: number; value: ClosureState | null } | null = null;

  constructor(private readonly database: Pool, private readonly rpc: RpcTransport, private readonly config: AppConfig) {}

  /** Current state; reads on-chain leverage for every Copper market, so live callers share it for a minute. */
  async state(now?: Date): Promise<ClosureState | null> {
    if (!now && this.cached && Date.now() - this.cached.at < 60_000) return this.cached.value;
    const value = await this.compute(now ?? new Date());
    if (!now) this.cached = { at: Date.now(), value };
    return value;
  }

  private async compute(now: Date): Promise<ClosureState | null> {
    if (!isCopperConfigured(this.config)) return null;
    const clearingHouse = contractConfigForVersion(this.config, "copper").FLOAT_CLEARING_HOUSE_ADDRESS as Address;
    const closureLeverage = this.config.COPPER_CLOSURE_MAX_LEVERAGE;
    const { rows } = await this.database.query<{ symbol: string }>(
      "SELECT symbol FROM public.markets WHERE 'copper' = ANY(releases) AND listed = TRUE ORDER BY symbol"
    );
    const markets = await Promise.all(rows.map(async ({ symbol }) => {
      const market = await readClearingMarket(this.rpc, clearingHouse, marketId(symbol));
      return { symbol, state: market.state, max_leverage: Number(market.maxLeverageE18 * 100n / E18) / 100 };
    }));
    const active = markets.filter((market) => market.state === 1 || market.state === 2);
    const aboveClosure = active.filter((market) => market.max_leverage > closureLeverage);

    const window = currentOrNextClosedWindow(now);
    const dueAt = window ? new Date(window.closedAt.getTime() - this.config.COPPER_CLOSURE_LEAD_HOURS * 3_600_000) : null;
    const phase: ClosurePhase = !window || !dueAt || now < dueAt ? "open" : now < window.closedAt ? "closure_due" : "closed";

    let action: ClosureAction | null = null;
    let summary: string | null = null;
    if (phase !== "open" && aboveClosure.length) {
      action = "apply_closure";
      summary = phase === "closed"
        ? `Copper's ${closureLeverage}x closure profile was not applied: ${aboveClosure.map((m) => m.symbol).join(", ")} still allow up to ${aboveClosure[0]!.max_leverage}x over the closure.`
        : `Apply Copper's ${closureLeverage}x closure profile before ${etTime(window!.closedAt)}: penny names can gap 20-40% while markets are closed.`;
    } else if (phase === "open" && active.length && aboveClosure.length === 0 && previousClosedWindow(now)) {
      action = "restore_launch";
      summary = `Markets have reopened: restore Copper's launch profile (currently ${closureLeverage}x).`;
    }
    return {
      phase,
      profile_due_at: dueAt?.toISOString() ?? null,
      closes_at: window?.closedAt.toISOString() ?? null,
      reopens_at: window?.reopensAt.toISOString() ?? null,
      closure_max_leverage: closureLeverage,
      markets: markets.map(({ symbol, max_leverage }) => ({ symbol, max_leverage })),
      action,
      summary,
      command: action === "apply_closure" ? "contracts/script/copper-profile.sh closure"
        : action === "restore_launch" ? "contracts/script/copper-profile.sh launch" : null
    };
  }

  /** Sends at most one owner reminder per closure window and action. */
  async remind(now: Date = new Date()): Promise<void> {
    if (!this.config.TELEGRAM_BOT_TOKEN) return;
    const state = await this.state(now);
    if (!state?.action || !state.summary) return;
    const window = state.action === "apply_closure" ? currentOrNextClosedWindow(now) : previousClosedWindow(now);
    if (!window) return;
    const clearingHouse = contractConfigForVersion(this.config, "copper").FLOAT_CLEARING_HOUSE_ADDRESS as Address;
    const data = encodeFunctionData({ abi: ownerAbi, functionName: "owner" });
    const owner = decodeFunctionResult({ abi: ownerAbi, functionName: "owner", data: await this.rpc.call({ to: clearingHouse, data }) });
    const chat = await this.database.query<{ telegram_chat_id: string }>(
      "SELECT telegram_chat_id FROM public.liquidation_telegram_links WHERE wallet_address=$1 AND enabled = TRUE", [owner.toLowerCase()]
    );
    const chatId = chat.rows[0]?.telegram_chat_id;
    if (!chatId) return;
    const claimed = await this.database.query(
      "INSERT INTO public.copper_closure_reminders (anchor_at, action) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1",
      [window.anchorAt, state.action]
    );
    if (!claimed.rowCount) return;
    try {
      await telegramRequest(this.config, "sendMessage", {
        chat_id: chatId,
        text: `FloatSheets Copper: owner action needed\n${state.summary}\n\nRun from the repository, signing with the Copper owner wallet:\n${state.command}`
      });
    } catch (error) {
      // Let the next run retry rather than silently skipping this window.
      await this.database.query("DELETE FROM public.copper_closure_reminders WHERE anchor_at=$1 AND action=$2", [window.anchorAt, state.action]);
      console.error(JSON.stringify({ event: "copper_closure_reminder_failed", error: safeErrorMessage(error) }));
    }
  }
}
