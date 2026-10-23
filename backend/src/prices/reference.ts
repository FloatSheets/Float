import type { Pool } from "pg";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import type { AppConfig } from "../config";
import type { RpcTransport } from "../chain/rpc";
import { quoteNotionalsForMarketCap } from "../markets/monitor";
import { safeErrorMessage } from "../safe-error";

/**
 * Reference pricing for markets whose Uniswap pool is too thin to be an oracle
 * (price_source = 'reference'). Two off-chain sources, neither of which can be
 * moved by trading on Robinhood Chain:
 *
 *  - robinhood: Robinhood's own Stock Token quote (rhj/prices tokenBid/tokenAsk,
 *    already in token units, i.e. share price × multiplier), matched by the
 *    official token contract address, never by symbol;
 *  - pyth: the Pyth equity feed for the underlying share × the token's on-chain
 *    uiMultiplier (dropped for 24h after a multiplier change).
 *
 * The Uniswap pool is NOT a price source here: its spot can be pushed with
 * a few thousand USDG.
 *
 * The published mark is the live reference mid (the median of fresh sources,
 * or Robinhood's quote alone if they disagree). It is not a lagging TWAP:
 * entries, exits and liquidations all happen near the real price. A 15-minute
 * average is kept only as a sanity band for opens.
 *
 * Frozen (halt, Stock Token oracle paused, or no live source so the last mark is
 * being held): the publisher signs the mark with the on-chain breaker set, so
 * liquidations and LP queue settlement pause, and closes are quoted at a 7%
 * adverse spread, so a stale mark is not a free option.
 *
 * Results go to pool_snapshots and quote_samples in the shape the Uniswap
 * monitor writes, so the publisher, risk screen and quote service are shared.
 */

export type SourceName = "robinhood" | "pyth";
export type SourceQuote = {
  source: SourceName;
  bid: number | null;
  ask: number | null;
  mid: number;
  sourceTime: Date;
  halted: boolean;
};

export type ReferenceMarket = {
  id: string;
  symbol: string;
  token_address: Address;
  pyth_feed_id: string | null;
  max_ticket_usdg: string;
  min_half_spread_bps: number;
  max_spot_twap_deviation_bps: number;
  min_sources_for_open: number;
};

export type Aggregate = {
  /** The mark to publish (null: no live source). */
  mid: number | null;
  sourcesUsed: number;
  /** Max-minus-min spread between fresh sources, in bps of the lower one. */
  dispersionBps: number;
  halfSpreadBps: number;
  /** Opens allowed (before the TWAP sanity band is applied). */
  tradable: boolean;
  /** On-chain breaker: no liquidations, closes at the frozen spread. */
  frozen: boolean;
  frozenReason: string | null;
  used: Set<SourceQuote>;
};

export type AggregateOptions = {
  now: Date;
  maxAgeSeconds: number;
  maxDispersionBps: number;
  minSourcesForOpen: number;
  minHalfSpreadBps: number;
  tokenPaused: boolean;
  pendingMultiplier: boolean;
};

/** Half spread applied to every quote while a market is frozen (below the 750 bps protocol bound). */
export const FROZEN_HALF_SPREAD_BPS = 700;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Pure aggregation: which sources count, the mark, and what is allowed. */
export function aggregateReference(quotes: SourceQuote[], options: AggregateOptions): Aggregate {
  const fresh = quotes.filter((quote) =>
    Number.isFinite(quote.mid) && quote.mid > 0
    && (options.now.getTime() - quote.sourceTime.getTime()) / 1_000 <= options.maxAgeSeconds
    && quote.sourceTime.getTime() <= options.now.getTime() + 5_000
  );
  const used = new Set(fresh);
  if (fresh.length === 0) {
    return { mid: null, sourcesUsed: 0, dispersionBps: 0, halfSpreadBps: FROZEN_HALF_SPREAD_BPS, tradable: false, frozen: true, frozenReason: "no live price source", used };
  }
  const mids = fresh.map((quote) => quote.mid);
  const dispersionBps = Math.round((Math.max(...mids) - Math.min(...mids)) / Math.min(...mids) * 10_000);
  const robinhood = fresh.find((quote) => quote.source === "robinhood");
  const disagree = fresh.length > 1 && dispersionBps > options.maxDispersionBps;
  // On disagreement, Robinhood's own token quote is the mark (it already includes the multiplier).
  const mid = disagree && robinhood ? robinhood.mid : median(mids);
  const quotedHalfSpread = robinhood?.bid && robinhood.ask && robinhood.ask >= robinhood.bid
    ? Math.ceil((robinhood.ask - robinhood.bid) / 2 / mid * 10_000) : 0;
  let frozenReason: string | null = null;
  let frozen = false;
  if (fresh.some((quote) => quote.halted)) { frozen = true; frozenReason = "trading halt reported by a price source"; }
  else if (options.tokenPaused) { frozen = true; frozenReason = "Stock Token oracle paused by Robinhood (corporate action)"; }
  else if (options.pendingMultiplier) frozenReason = "Stock Token multiplier change is pending";
  else if (disagree) frozenReason = `price sources disagree by ${dispersionBps} bps`;
  else if (fresh.length < options.minSourcesForOpen) frozenReason = `${fresh.length} of ${options.minSourcesForOpen} required price sources are live`;
  const halfSpreadBps = frozen ? FROZEN_HALF_SPREAD_BPS : Math.max(options.minHalfSpreadBps, quotedHalfSpread);
  return { mid, sourcesUsed: fresh.length, dispersionBps, halfSpreadBps, tradable: frozenReason === null, frozen, frozenReason, used };
}

/**
 * Quote matrix rows, in bps against the published mark (the reference mid): a
 * buy pays the ask side, a sell gets the bid side, plus a small size impact.
 */
export function referenceQuoteSamples(input: {
  mid: number; halfSpreadBps: number; notionals: number[]; virtualDepthUsdg: number;
}): { notional: number; buyBps: number; sellBps: number; buyOut: bigint; sellOut: bigint }[] {
  const halfSpread = input.halfSpreadBps / 10_000;
  return input.notionals.map((notional) => {
    const impact = notional / input.virtualDepthUsdg / 2;
    const buyPrice = input.mid * (1 + halfSpread + impact);
    const sellPrice = input.mid * (1 - halfSpread - impact);
    return {
      notional,
      // Round up (against the trader), ignoring float noise below 1e-6 bps.
      buyBps: Math.ceil((buyPrice / input.mid - 1) * 10_000 - 1e-6),
      // Same convention as the Uniswap monitor: execution = mark × (1 − sellBps).
      sellBps: Math.ceil((1 - sellPrice / input.mid) * 10_000 - 1e-6),
      buyOut: BigInt(Math.floor(notional / buyPrice * 1e18)),
      sellOut: BigInt(Math.floor(notional / input.mid * sellPrice * 1e6))
    };
  });
}

type RobinhoodQuote = { bid: number; ask: number; halted: boolean; generatedAt: Date };

/** Robinhood Stock Token quotes keyed by lower-case contract address on chain 4663. */
export async function fetchRobinhoodQuotes(url: string, fetcher: typeof fetch = fetch): Promise<Map<string, RobinhoodQuote>> {
  const response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Robinhood prices returned HTTP ${response.status}`);
  const payload = await response.json() as { quotes?: {
    deployments?: { contractAddress?: string; chainId?: number }[];
    tokenBid?: string; tokenAsk?: string; isTradingHalt?: boolean; generatedAt?: string;
  }[] };
  const quotes = new Map<string, RobinhoodQuote>();
  for (const quote of payload.quotes ?? []) {
    const deployment = quote.deployments?.find((item) => item.chainId === 4663 && item.contractAddress);
    const bid = Number(quote.tokenBid);
    const ask = Number(quote.tokenAsk);
    const generatedAt = new Date(quote.generatedAt ?? "");
    if (!deployment || !(bid > 0) || !(ask >= bid) || Number.isNaN(generatedAt.getTime())) continue;
    quotes.set(deployment.contractAddress!.toLowerCase(), { bid, ask, halted: quote.isTradingHalt === true, generatedAt });
  }
  return quotes;
}

type PythPrice = { price: number; conf: number; publishTime: Date };

/** Latest Pyth prices keyed by feed id (no 0x). */
export async function fetchPythPrices(hermesUrl: string, ids: string[], apiKey?: string, fetcher: typeof fetch = fetch): Promise<Map<string, PythPrice>> {
  const prices = new Map<string, PythPrice>();
  if (ids.length === 0) return prices;
  const query = ids.map((id) => `ids[]=${id}`).join("&");
  const headers: Record<string, string> = { accept: "application/json" };
  // Hermes requires an API key since the Pyth Core upgrade [verify header name with your key].
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetcher(`${hermesUrl.replace(/\/$/, "")}/v2/updates/price/latest?${query}&parsed=true`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Pyth Hermes returned HTTP ${response.status}`);
  const payload = await response.json() as { parsed?: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[] };
  for (const item of payload.parsed ?? []) {
    const scale = Math.pow(10, item.price.expo);
    const price = Number(item.price.price) * scale;
    if (!(price > 0)) continue;
    prices.set(item.id.replace(/^0x/, "").toLowerCase(), { price, conf: Number(item.price.conf) * scale, publishTime: new Date(item.price.publish_time * 1_000) });
  }
  return prices;
}

const stockTokenAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function oraclePaused() view returns (bool)"
]);

/** Robinhood Stock Tokens are beacon proxies behind this beacon; impostors are not. */
export const ROBINHOOD_STOCK_TOKEN_BEACON = "0xe10b6f6b275de231345c20d14ab812db62151b00";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;

export async function isOfficialStockToken(rpc: RpcTransport, token: Address): Promise<boolean> {
  if (!rpc.getStorageAt) throw new Error("RPC transport cannot read storage");
  const value: Hex = await rpc.getStorageAt(token, BEACON_SLOT);
  return `0x${value.slice(-40)}`.toLowerCase() === ROBINHOOD_STOCK_TOKEN_BEACON;
}

type TokenState = { multiplier: number; paused: boolean; pendingMultiplier: boolean; recentMultiplierChange: boolean };

export async function readTokenState(rpc: RpcTransport, token: Address, now: Date): Promise<TokenState> {
  const call = async <T>(functionName: "uiMultiplier" | "newUIMultiplier" | "effectiveAt" | "oraclePaused"): Promise<T> =>
    decodeFunctionResult({ abi: stockTokenAbi, functionName, data: await rpc.call({ to: token, data: encodeFunctionData({ abi: stockTokenAbi, functionName }) }) }) as T;
  const [multiplier, paused, next, effectiveAt] = await Promise.all([
    call<bigint>("uiMultiplier"),
    call<boolean>("oraclePaused"),
    call<bigint>("newUIMultiplier").catch(() => 0n),
    call<bigint>("effectiveAt").catch(() => 0n)
  ]);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1_000));
  // A staged multiplier inside the next 24 hours: no new positions until it applies.
  const pendingMultiplier = next !== 0n && next !== multiplier && effectiveAt > nowSeconds && effectiveAt - nowSeconds <= 86_400n;
  // A multiplier that changed in the last 24 hours: Pyth (share price) may not line up yet.
  const recentMultiplierChange = effectiveAt !== 0n && effectiveAt <= nowSeconds && nowSeconds - effectiveAt < 86_400n;
  return { multiplier: Number(multiplier) / 1e18, paused, pendingMultiplier, recentMultiplierChange };
}

export class ReferencePriceMonitor {
  private refreshing = false;
  private readonly lastGood = new Map<string, { mid: number; at: Date }>();
  /** Robinhood quotes whose bid/ask haven't changed: treat as stale after a while. */
  private readonly lastChange = new Map<string, { key: string; at: Date }>();
  private readonly verified = new Map<string, { official: boolean; at: number }>();

  constructor(
    private readonly database: Pool,
    private readonly rpc: RpcTransport,
    private readonly config: Pick<AppConfig,
      "ROBINHOOD_PRICES_URL" | "PYTH_HERMES_URL" | "PYTH_API_KEY" | "REFERENCE_SOURCE_MAX_AGE_SECONDS"
      | "REFERENCE_MAX_SOURCE_DISPERSION_BPS" | "REFERENCE_TWAP_WINDOW_SECONDS" | "REFERENCE_VIRTUAL_DEPTH_USDG"
      | "REFERENCE_HOLD_MAX_SECONDS" | "REFERENCE_UNCHANGED_QUOTE_SECONDS" | "REFERENCE_MIN_WINDOW_POINTS">,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { rows } = await this.database.query<ReferenceMarket>(
        `SELECT id, symbol, token_address, pyth_feed_id, max_ticket_usdg::text,
                min_half_spread_bps, max_spot_twap_deviation_bps, min_sources_for_open
         FROM public.markets WHERE price_source = 'reference' AND status != 'disabled' ORDER BY symbol`
      );
      if (rows.length === 0) return;
      const now = new Date();
      const [robinhood, pyth] = await Promise.all([
        fetchRobinhoodQuotes(this.config.ROBINHOOD_PRICES_URL, this.fetcher).catch((error) => {
          console.error(JSON.stringify({ event: "reference_source_failed", source: "robinhood", error: safeErrorMessage(error) }));
          return new Map<string, RobinhoodQuote>();
        }),
        fetchPythPrices(this.config.PYTH_HERMES_URL, rows.flatMap((row) => row.pyth_feed_id ? [row.pyth_feed_id] : []), this.config.PYTH_API_KEY, this.fetcher).catch((error) => {
          console.error(JSON.stringify({ event: "reference_source_failed", source: "pyth", error: safeErrorMessage(error) }));
          return new Map<string, PythPrice>();
        })
      ]);
      for (const market of rows) {
        try {
          // Fail closed: a market is priced only once its token is a verified Robinhood Stock Token.
          if (!(await this.isVerified(market, robinhood))) continue;
          await this.refreshMarket(market, robinhood, pyth, now);
        } catch (error) { console.error(JSON.stringify({ event: "reference_refresh_failed", market: market.symbol, error: safeErrorMessage(error) })); }
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Official = a Robinhood beacon proxy, or listed by contract address in
   * Robinhood's own price feed (covers a future beacon migration). Re-checked
   * hourly. A market that fails is set 'restricted' (close-only; its existing
   * positions keep their last published mark path) and is not priced.
   */
  private async isVerified(market: ReferenceMarket, robinhood: Map<string, RobinhoodQuote>): Promise<boolean> {
    const key = market.token_address.toLowerCase();
    const cached = this.verified.get(key);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.official;
    const official = robinhood.has(key) || await isOfficialStockToken(this.rpc, market.token_address);
    this.verified.set(key, { official, at: Date.now() });
    if (!official) {
      await this.database.query("UPDATE public.markets SET status='restricted', updated_at=now() WHERE id=$1 AND status <> 'disabled'", [market.id]);
      console.error(JSON.stringify({ event: "reference_market_restricted_unverified_token", market: market.symbol, token: market.token_address }));
    }
    return official;
  }

  /**
   * Robinhood source time: its generatedAt, unless the bid/ask hasn't changed for
   * longer than REFERENCE_UNCHANGED_QUOTE_SECONDS. The last change is seeded
   * from reference_quotes after a restart; with no history the quote counts as
   * stale until a change is actually seen.
   */
  private async robinhoodTime(market: ReferenceMarket, quote: RobinhoodQuote, now: Date): Promise<Date> {
    const token = market.token_address.toLowerCase();
    const key = `${quote.bid}:${quote.ask}`;
    let previous = this.lastChange.get(token);
    if (!previous) {
      previous = { key, at: await this.lastRobinhoodChange(market.id, quote) };
      this.lastChange.set(token, previous);
    } else if (previous.key !== key) {
      previous = { key, at: now };
      this.lastChange.set(token, previous);
    }
    const unchangedSeconds = (now.getTime() - previous.at.getTime()) / 1_000;
    return unchangedSeconds > this.config.REFERENCE_UNCHANGED_QUOTE_SECONDS ? previous.at : quote.generatedAt;
  }

  /** When this bid/ask first appeared after the last different one (epoch 0 if never seen changing). */
  private async lastRobinhoodChange(marketId: string, quote: RobinhoodQuote): Promise<Date> {
    const { rows } = await this.database.query<{ since: Date | null }>(
      `SELECT min(q.observed_at) AS since FROM public.reference_quotes q
       WHERE q.market_id = $1 AND q.source = 'robinhood'
         AND q.observed_at > (
           SELECT max(d.observed_at) FROM public.reference_quotes d
           WHERE d.market_id = $1 AND d.source = 'robinhood' AND (d.bid_usdg <> $2 OR d.ask_usdg <> $3)
         )`, [marketId, quote.bid, quote.ask]
    );
    return rows[0]?.since ?? new Date(0);
  }

  private async refreshMarket(market: ReferenceMarket, robinhood: Map<string, RobinhoodQuote>, pyth: Map<string, PythPrice>, now: Date): Promise<void> {
    const token = await readTokenState(this.rpc, market.token_address, now);
    const quotes: SourceQuote[] = [];
    const rh = robinhood.get(market.token_address.toLowerCase());
    if (rh) quotes.push({ source: "robinhood", bid: rh.bid, ask: rh.ask, mid: (rh.bid + rh.ask) / 2, sourceTime: await this.robinhoodTime(market, rh, now), halted: rh.halted });
    const py = market.pyth_feed_id ? pyth.get(market.pyth_feed_id) : undefined;
    if (py && token.multiplier > 0 && !token.recentMultiplierChange) {
      const mid = py.price * token.multiplier;
      quotes.push({ source: "pyth", bid: mid - py.conf * token.multiplier, ask: mid + py.conf * token.multiplier, mid, sourceTime: py.publishTime, halted: false });
    }
    const aggregate = aggregateReference(quotes, {
      now,
      maxAgeSeconds: this.config.REFERENCE_SOURCE_MAX_AGE_SECONDS,
      maxDispersionBps: this.config.REFERENCE_MAX_SOURCE_DISPERSION_BPS,
      minSourcesForOpen: market.min_sources_for_open,
      minHalfSpreadBps: market.min_half_spread_bps,
      tokenPaused: token.paused,
      pendingMultiplier: token.pendingMultiplier
    });

    // No live source: hold the last good mark for a bounded time, frozen (no
    // liquidations or opens; closes at the frozen spread).
    let mid = aggregate.mid;
    if (mid !== null) { if (!aggregate.frozen) this.lastGood.set(market.id, { mid, at: now }); }
    else {
      const held = this.lastGood.get(market.id) ?? await this.lastSnapshotMid(market.id);
      if (!held || (now.getTime() - held.at.getTime()) / 1_000 > this.config.REFERENCE_HOLD_MAX_SECONDS) {
        await this.recordQuotes(market, quotes, aggregate, now);
        return;
      }
      mid = held.mid;
    }

    const { average, points } = await this.windowAverage(market.id, mid, now);
    const deviationBps = Math.round(Math.abs(mid - average) / average * 10_000);
    const warmedUp = points >= this.config.REFERENCE_MIN_WINDOW_POINTS;
    const tradable = aggregate.tradable && warmedUp && deviationBps <= market.max_spot_twap_deviation_bps;
    const frozenReason = aggregate.frozenReason
      ?? (!warmedUp ? `collecting live prices (${points} of ${this.config.REFERENCE_MIN_WINDOW_POINTS})` : tradable ? null : `price is ${deviationBps} bps from its 15-minute average`);
    const samples = referenceQuoteSamples({
      mid, halfSpreadBps: aggregate.halfSpreadBps,
      notionals: quoteNotionalsForMarketCap(market.max_ticket_usdg),
      virtualDepthUsdg: this.config.REFERENCE_VIRTUAL_DEPTH_USDG
    });
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // twap = spot = the mark. The 15-minute average only gates opens.
      await client.query(
        `INSERT INTO public.pool_snapshots (market_id, observed_at, sqrt_price_x96, liquidity, usdg_balance, twap_price_usdg, spot_price_usdg,
           spot_twap_deviation_bps, oracle_tradable, source, sources_used, source_dispersion_bps, frozen_reason, oracle_frozen, reference_average_usdg)
         VALUES ($1,$2,0,0,$3,$4,$4,$5,$6,'reference',$7,$8,$9,$10,$11)`,
        [market.id, now, (BigInt(this.config.REFERENCE_VIRTUAL_DEPTH_USDG) * 1_000_000n).toString(), mid, deviationBps, tradable,
          aggregate.sourcesUsed, aggregate.dispersionBps, frozenReason, aggregate.frozen, average]
      );
      for (const sample of samples) {
        await client.query(
          `INSERT INTO public.quote_samples (market_id, observed_at, notional_usdg, direction, quoted_output, execution_degradation_bps)
           VALUES ($1,$2,$3,'buy',$4,$5),($1,$2,$3,'sell',$6,$7)`,
          [market.id, now, sample.notional, sample.buyOut.toString(), sample.buyBps, sample.sellOut.toString(), sample.sellBps]
        );
      }
      await this.recordQuotes(market, quotes, aggregate, now, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Average of recent unfrozen marks plus this one: the sanity band for opens. */
  private async windowAverage(marketId: string, mid: number, now: Date): Promise<{ average: number; points: number }> {
    const { rows } = await this.database.query<{ total: string | null; points: string }>(
      `SELECT sum(spot_price_usdg)::text AS total, count(*)::text AS points FROM public.pool_snapshots
       WHERE market_id = $1 AND source = 'reference' AND NOT oracle_frozen
         AND observed_at > $2::timestamptz - ($3 || ' seconds')::interval`,
      [marketId, now, String(this.config.REFERENCE_TWAP_WINDOW_SECONDS)]
    );
    const points = Number(rows[0]?.points ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    return { average: (total + mid) / (points + 1), points };
  }

  private async lastSnapshotMid(marketId: string): Promise<{ mid: number; at: Date } | undefined> {
    const { rows } = await this.database.query<{ spot_price_usdg: string; observed_at: Date }>(
      `SELECT spot_price_usdg::text, observed_at FROM public.pool_snapshots WHERE market_id=$1 AND source='reference' AND NOT oracle_frozen
       ORDER BY observed_at DESC LIMIT 1`, [marketId]
    );
    return rows[0] ? { mid: Number(rows[0].spot_price_usdg), at: rows[0].observed_at } : undefined;
  }

  private async recordQuotes(market: ReferenceMarket, quotes: SourceQuote[], aggregate: Aggregate, now: Date, client: Pick<Pool, "query"> = this.database): Promise<void> {
    for (const quote of quotes) {
      await client.query(
        `INSERT INTO public.reference_quotes (market_id, observed_at, source, bid_usdg, ask_usdg, mid_usdg, source_time, halted, used, reject_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [market.id, now, quote.source, quote.bid, quote.ask, quote.mid, quote.sourceTime, quote.halted, aggregate.used.has(quote),
          aggregate.used.has(quote) ? null : "stale or invalid"]
      );
    }
  }
}

/** Startup guard: lists reference markets whose token is not a Robinhood beacon proxy. Throws if storage can't be read. */
export async function assertOfficialStockTokens(database: Pool, rpc: RpcTransport): Promise<string[]> {
  const { rows } = await database.query<{ symbol: string; token_address: Address }>(
    "SELECT symbol, token_address FROM public.markets WHERE price_source = 'reference' AND status != 'disabled'"
  );
  const impostors: string[] = [];
  for (const row of rows) if (!(await isOfficialStockToken(rpc, row.token_address))) impostors.push(row.symbol);
  return impostors;
}
