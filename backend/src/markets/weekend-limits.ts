import type { Pool } from "pg";
import type { Address } from "viem";

import type { AppConfig } from "../config";
import { closedWindow, type ClosedWindow } from "./sessions";

const BPS = 10_000n;
const USDG_UNITS = 1_000_000n;

export type WeekendLimitOptions = {
  enabled: boolean;
  /** Per-wallet, per-market weekend allowance as a share of the market's max ticket. */
  capBps: number;
  /** Minimum time between a wallet's executed weekend opens on one market. */
  cooldownSeconds: number;
};

export type WeekendAllowance = {
  window: ClosedWindow;
  capUsdg: bigint;
  usedUsdg: bigint;
  pendingUsdg: bigint;
  cooldownUntil: Date | null;
};

export type WeekendAllowanceView = {
  market: string;
  reopens_at: string;
  cap_usdg: string;
  used_usdg: string;
  pending_usdg: string;
  remaining_usdg: string;
  cooldown_until: string | null;
};

/** Reads ClearingHouse.quoteUsed(trader, nonce). */
export type QuoteUsedReader = (trader: Address, nonce: bigint) => Promise<boolean>;

export function weekendLimitOptions(config: AppConfig): WeekendLimitOptions {
  return {
    enabled: config.WEEKEND_WALLET_LIMITS_ENABLED === "true",
    capBps: config.WEEKEND_WALLET_CAP_BPS,
    cooldownSeconds: config.WEEKEND_WALLET_COOLDOWN_SECONDS
  };
}

function usd(units: bigint): string {
  const whole = units / USDG_UNITS;
  const cents = (units % USDG_UNITS) / 10_000n;
  return `$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

export function usdgDecimal(units: bigint): string {
  return `${units / USDG_UNITS}.${(units % USDG_UNITS).toString().padStart(6, "0")}`;
}

function parseUsdg(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0").slice(0, 6)}`);
}

/**
 * Per-wallet weekend limits. While the underlying is closed, one large wallet
 * can push a thin stock-token pool and liquidate the other side, as happened
 * with a single ~$10M Sunday short on a competing venue. Each wallet may add
 * only a fraction of the normal ticket per market per closure, and must wait
 * between executed opens. Closes are never limited.
 */
export class WeekendWalletLimits {
  constructor(
    private readonly database: Pool,
    private readonly clearingHouse: Address,
    private readonly options: WeekendLimitOptions,
    private readonly quoteUsed: QuoteUsedReader
  ) {}

  async allowance(symbol: string, trader: Address, now: Date = new Date()): Promise<WeekendAllowance | null> {
    if (!this.options.enabled) return null;
    const window = closedWindow(now);
    if (!window) return null;
    const market = await this.database.query<{ max_ticket_usdg: string }>(
      "SELECT max_ticket_usdg::text FROM public.markets WHERE symbol=$1", [symbol.toUpperCase()]
    );
    if (!market.rows[0]) return null;
    const capUsdg = parseUsdg(market.rows[0].max_ticket_usdg) * BigInt(this.options.capBps) / BPS;
    const { rows } = await this.database.query<{ id: string; nonce: string; notional_usdg: string; issued_at: Date; expires_at: Date; executed: boolean | null }>(
      `SELECT id::text, nonce::text, notional_usdg::text, issued_at, expires_at, executed FROM public.weekend_quotes
       WHERE clearing_house=$1 AND trader=$2 AND symbol=$3 AND anchor_at=$4`,
      [this.clearingHouse.toLowerCase(), trader.toLowerCase(), symbol.toUpperCase(), window.anchorAt]
    );
    let usedUsdg = 0n;
    let pendingUsdg = 0n;
    let lastExecuted: Date | null = null;
    for (const row of rows) {
      let executed = row.executed;
      if (executed === null && row.expires_at <= now) {
        // Expired: the nonce is now final, so settle it once and remember it.
        executed = await this.quoteUsed(trader, BigInt(row.nonce));
        await this.database.query("UPDATE public.weekend_quotes SET executed=$2 WHERE id=$1", [row.id, executed]);
      }
      const notional = BigInt(row.notional_usdg);
      if (executed === true) {
        usedUsdg += notional;
        if (!lastExecuted || row.issued_at > lastExecuted) lastExecuted = row.issued_at;
      } else if (executed === null) {
        // Still executable: reserve it so parallel quotes cannot exceed the cap.
        pendingUsdg += notional;
      }
    }
    const cooldownUntil = lastExecuted ? new Date(lastExecuted.getTime() + this.options.cooldownSeconds * 1_000) : null;
    return { window, capUsdg, usedUsdg, pendingUsdg, cooldownUntil: cooldownUntil && cooldownUntil > now ? cooldownUntil : null };
  }

  /** Why an opening quote of `notionalUsdg` is refused, or null when allowed. */
  async refusal(symbol: string, trader: Address, notionalUsdg: bigint, now: Date = new Date()): Promise<string | null> {
    const allowance = await this.allowance(symbol, trader, now);
    if (!allowance) return null;
    const market = symbol.toUpperCase();
    if (allowance.cooldownUntil) {
      const wait = Math.ceil((allowance.cooldownUntil.getTime() - now.getTime()) / 60_000);
      return `While ${market}'s underlying is closed, each wallet can open once every ${Math.round(this.options.cooldownSeconds / 60)} minutes. Try again in ${wait} minute${wait === 1 ? "" : "s"}; you can still close.`;
    }
    const committed = allowance.usedUsdg + allowance.pendingUsdg;
    if (committed + notionalUsdg > allowance.capUsdg) {
      const remaining = allowance.capUsdg > committed ? allowance.capUsdg - committed : 0n;
      return `While ${market}'s underlying is closed, each wallet can add up to ${usd(allowance.capUsdg)} per market. You have ${usd(remaining)} left until trading resumes; you can still close.`;
    }
    return null;
  }

  async record(symbol: string, trader: Address, nonce: bigint, notionalUsdg: bigint, expiresAt: Date, now: Date = new Date()): Promise<void> {
    if (!this.options.enabled) return;
    const window = closedWindow(now);
    if (!window) return;
    await this.database.query(
      `INSERT INTO public.weekend_quotes (clearing_house, trader, symbol, anchor_at, nonce, notional_usdg, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (clearing_house, trader, nonce) DO NOTHING`,
      [this.clearingHouse.toLowerCase(), trader.toLowerCase(), symbol.toUpperCase(), window.anchorAt, nonce.toString(), notionalUsdg.toString(), now, expiresAt]
    );
  }

  view(symbol: string, allowance: WeekendAllowance): WeekendAllowanceView {
    const committed = allowance.usedUsdg + allowance.pendingUsdg;
    return {
      market: symbol.toUpperCase(),
      reopens_at: allowance.window.reopensAt.toISOString(),
      cap_usdg: usdgDecimal(allowance.capUsdg),
      used_usdg: usdgDecimal(allowance.usedUsdg),
      pending_usdg: usdgDecimal(allowance.pendingUsdg),
      remaining_usdg: usdgDecimal(allowance.capUsdg > committed ? allowance.capUsdg - committed : 0n),
      cooldown_until: allowance.cooldownUntil?.toISOString() ?? null
    };
  }
}
