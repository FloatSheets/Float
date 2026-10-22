import { Router } from "express";
import type { Pool } from "pg";

import { assessMarketRisk } from "../markets/risk";
import { candleHistorySql, historyRanges } from '../markets/history';
import { marketId } from '../chain/protocol';
import { readClearingMarket, readOraclePrice } from '../chain/protocol-read';
import type { RpcTransport } from '../chain/rpc';
import type { Address } from 'viem';
import { contractVersionFromRequest } from '../contract-version';
import { HALT_FEED_STALE_SECONDS, readActiveHalts } from '../markets/halts';
import { closedWindow } from '../markets/sessions';
import { decimalToE18, readPoolPriceE18, weekendBandView, WeekendBands, type WeekendBandOptions, type WeekendBandView } from '../markets/weekend-bands';

type LiveMarketDependencies = { rpc: RpcTransport; clearingHouse: Address; oracle: Address };
type VersionedLiveMarketDependencies = Partial<Record<'goldlake' | 'silverlake' | 'amber' | 'jasper' | 'meadow' | 'legacy-orion', LiveMarketDependencies>>;

export function effectiveMaxTicketUsdg(backendCap: number | string, onchainCapE6: bigint): number {
  return Math.min(Number(backendCap), Number(onchainCapE6) / 1_000_000);
}

export function createMarketsRouter(
  database: Pool,
  maxPriceAgeSeconds = 120,
  live?: LiveMarketDependencies | VersionedLiveMarketDependencies,
  bandOptions: WeekendBandOptions = { enabled: false, maxBandBps: 500, shiftAfterSeconds: 3_600, maxShifts: 2 }
): Router {
  const router = Router();
  const bands = new WeekendBands(database, bandOptions);
  async function bandView(symbol: string, poolPrice?: string | null): Promise<WeekendBandView | null> {
    const band = await bands.band(symbol);
    if (!band) return null;
    const pool = poolPrice ? decimalToE18(String(poolPrice)) : await readPoolPriceE18(database, symbol);
    return weekendBandView(band, pool, bandOptions.maxShifts);
  }

  router.get("/", async (request, response, next) => {
    try {
      const result = await database.query(
        `SELECT m.symbol, m.status, m.max_leverage, m.max_ticket_usdg,
                m.min_half_spread_bps, m.max_half_spread_bps,
                s.observed_at, s.liquidity, s.usdg_balance, s.twap_price_usdg, s.spot_price_usdg,
                s.spot_twap_deviation_bps, s.oracle_tradable
         FROM public.markets m
         LEFT JOIN LATERAL (
           SELECT observed_at, liquidity, usdg_balance, twap_price_usdg, spot_price_usdg,
                  spot_twap_deviation_bps, oracle_tradable FROM public.pool_snapshots
           WHERE market_id = m.id ORDER BY observed_at DESC LIMIT 1
         ) s ON true
         ORDER BY m.symbol`
      );
      const halts = await readActiveHalts(database);
      const rows = await Promise.all(result.rows.map(async (row) => ({
        ...row,
        exchange_halt: halts.get(String(row.symbol).toUpperCase()) ?? null,
        weekend_band: await bandView(String(row.symbol), row.twap_price_usdg)
      })));
      if (!live) return response.json({ markets: rows });
      const selectedLive = 'rpc' in live ? live : live[contractVersionFromRequest(request)];
      if (!selectedLive) return response.status(503).json({ error: 'live market reads are unavailable for this contract version' });
      const markets = await Promise.all(rows.map(async (row) => {
        const id = marketId(row.symbol);
        const market = await readClearingMarket(selectedLive.rpc, selectedLive.clearingHouse, id);
        return {
          ...row,
          max_leverage: Number(market.maxLeverageE18) / 1e18,
          max_ticket_usdg: effectiveMaxTicketUsdg(row.max_ticket_usdg, market.maxPositionNotionalUsdg),
          onchain_market_state: market.state
        };
      }));
      response.json({ markets });
    } catch (error) {
      next(error);
    }
  });

  // Registered before /:symbol so these paths are never read as market symbols.
  router.get('/weekend-bands', async (_request, response, next) => {
    try {
      const window = bandOptions.enabled ? closedWindow(new Date()) : null;
      const symbols = await database.query<{ symbol: string; twap_price_usdg: string | null }>(
        `SELECT m.symbol, s.twap_price_usdg::text FROM public.markets m LEFT JOIN LATERAL (
           SELECT twap_price_usdg FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
         ) s ON true ORDER BY m.symbol`
      );
      response.json({
        enabled: bandOptions.enabled,
        underlying_closed: window !== null,
        reopens_at: window?.reopensAt.toISOString() ?? null,
        bands: window ? (await Promise.all(symbols.rows.map((row) => bandView(row.symbol, row.twap_price_usdg)))).filter(Boolean) : []
      });
    } catch (error) { next(error); }
  });


  router.get('/halts', async (_request, response, next) => {
    try {
      const [halts, feed] = await Promise.all([
        readActiveHalts(database),
        database.query<{ last_success_at: Date | null; last_error: string | null }>('SELECT last_success_at,last_error FROM public.exchange_halt_feed WHERE id')
      ]);
      const lastSuccess = feed.rows[0]?.last_success_at ?? null;
      response.json({
        feed: {
          source: 'Nasdaq Trader trade halts',
          last_success_at: lastSuccess?.toISOString() ?? null,
          stale: !lastSuccess || (Date.now() - lastSuccess.getTime()) / 1_000 > HALT_FEED_STALE_SECONDS,
          last_error: feed.rows[0]?.last_error ?? null
        },
        active: [...halts.values()]
      });
    } catch (error) { next(error); }
  });

  router.get("/:symbol/history", async (request, response, next) => {
    try {
      const requestedRange = String(request.query.range ?? '1H').toUpperCase();
      const range = historyRanges[requestedRange] ? requestedRange : '1H';
      const { seconds, bucket } = historyRanges[range]!;
      if (request.query.format === 'candles') {
        const candles = await database.query(candleHistorySql, [request.params.symbol.toUpperCase(), String(seconds), bucket]);
        return response.json({ market: request.params.symbol.toUpperCase(), range, intervalSeconds: bucket, source: 'recorded-oracle', candles: candles.rows });
      }
      const result = await database.query(
        `SELECT * FROM (SELECT s.observed_at, s.twap_price_usdg, s.spot_price_usdg,
                s.spot_twap_deviation_bps, s.oracle_tradable
         FROM public.pool_snapshots s JOIN public.markets m ON m.id=s.market_id
         WHERE m.symbol=$1 AND s.observed_at >= now() - ($2::text || ' seconds')::interval
         ORDER BY s.observed_at DESC LIMIT 500) recent ORDER BY observed_at ASC`,
        [request.params.symbol.toUpperCase(), String(seconds)]
      );
      if (!result.rowCount) return response.status(404).json({ error: "market history not found" });
      response.json({ market: request.params.symbol.toUpperCase(), range, points: result.rows });
    } catch (error) { next(error); }
  });

  // This endpoint is deliberately a direct chain read. The dashboard uses it
  // for the displayed confidence and trade state; it must not infer either
  // from a cached pool snapshot or a configured spread limit.
  router.get('/:symbol/live', async (request, response, next) => {
    try {
      if (!live) return response.status(503).json({ error: 'live market reads are unavailable' });
      const selectedLive = 'rpc' in live ? live : live[contractVersionFromRequest(request)];
      if (!selectedLive) return response.status(503).json({ error: 'live market reads are unavailable for this contract version' });
      const symbol=request.params.symbol.toUpperCase();
      const market=await database.query<{
        id:string;status:'active'|'restricted'|'pilot'|'disabled';max_half_spread_bps:number;
        observed_at:Date|null;usdg_balance:string|null;oracle_tradable:boolean|null;
      }>(`SELECT m.id,m.status,m.max_half_spread_bps,s.observed_at,s.usdg_balance,s.oracle_tradable
          FROM public.markets m LEFT JOIN LATERAL (
            SELECT observed_at,usdg_balance,oracle_tradable FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
          ) s ON true WHERE m.symbol=$1`,[symbol]);
      const row=market.rows[0];
      if (!row) return response.status(404).json({ error: 'market not found' });
      const quotes=await database.query<{execution_degradation_bps:number}>(`SELECT execution_degradation_bps FROM public.quote_samples WHERE market_id=$1 AND observed_at=(
          SELECT q2.observed_at FROM public.quote_samples q2 WHERE q2.market_id=$1 GROUP BY q2.observed_at HAVING count(*)=10 ORDER BY q2.observed_at DESC LIMIT 1
        )`,[row.id]);
      const snapshotAgeSeconds=row.observed_at?(Date.now()-row.observed_at.getTime())/1_000:null;
      const monitoredState=assessMarketRisk({marketStatus:row.status,maxHalfSpreadBps:row.max_half_spread_bps,quoteBps:quotes.rows.map(q=>q.execution_degradation_bps),oracleTradable:row.oracle_tradable,snapshotAgeSeconds,usdgBalance:row.usdg_balance===null?null:BigInt(row.usdg_balance)},maxPriceAgeSeconds);
      const id=marketId(symbol);
      const [oracle,onchainMarket]=await Promise.all([readOraclePrice(selectedLive.rpc,selectedLive.oracle,id),readClearingMarket(selectedLive.rpc,selectedLive.clearingHouse,id)]);
      const oracleAgeSeconds=Number(BigInt(Math.floor(Date.now()/1_000))-oracle.timestamp);
      const oracleFresh=oracle.sequence!==0n&&oracleAgeSeconds<=maxPriceAgeSeconds&&!oracle.circuitBroken;
      const exchangeHalt=(await readActiveHalts(database)).get(symbol)??null;
      const weekendBand=await bandView(symbol);
      const state=onchainMarket.state===0?'HALTED':onchainMarket.state===2?'CLOSE_ONLY':exchangeHalt?'EXCHANGE_HALT':weekendBand?.pool_outside?'WEEKEND_BAND':(monitoredState!=='active'?'CLOSE_ONLY':(oracleFresh?'LIVE':'READY'));
      response.json({market:symbol,state,exchange_halt:exchangeHalt,weekend_band:weekendBand,monitored_state:monitoredState,onchain_market_state:onchainMarket.state,
        oracle_confidence_bps:oracle.confidenceBps.toString(),oracle_confidence_limit_bps:onchainMarket.maxOracleConfidenceBps.toString(),
        oracle_age_seconds:oracleAgeSeconds,oracle_circuit_broken:oracle.circuitBroken,oracle_fresh:oracleFresh});
    } catch (error) { next(error); }
  });

  router.get("/:symbol", async (request, response, next) => {
    try {
      const result = await database.query(
        `SELECT symbol, status, settlement_asset, uniswap_v3_pool_address, uniswap_v3_fee_tier,
                max_leverage, max_ticket_usdg, min_half_spread_bps, max_half_spread_bps
         FROM public.markets WHERE symbol=$1`, [request.params.symbol.toUpperCase()]
      );
      if (!result.rowCount) return response.status(404).json({ error: "market not found" });
      response.json({ market: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:symbol/quotes", async (request, response, next) => {
    try {
      const result = await database.query(
        `SELECT q.observed_at, q.notional_usdg, q.direction, q.execution_degradation_bps, q.quoted_output
         FROM public.quote_samples q JOIN public.markets m ON m.id = q.market_id
         WHERE m.symbol = $1 AND q.observed_at = (
           SELECT q2.observed_at FROM public.quote_samples q2
           WHERE q2.market_id = m.id
           GROUP BY q2.observed_at
           HAVING count(*) = 10
           ORDER BY q2.observed_at DESC LIMIT 1
         ) ORDER BY q.notional_usdg, q.direction`,
        [request.params.symbol.toUpperCase()]
      );
      if (!result.rowCount) return response.status(404).json({ error: "market quotes not found" });
      response.json({ market: request.params.symbol.toUpperCase(), quotes: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:symbol/risk", async (request, response, next) => {
    try {
      const symbol = request.params.symbol.toUpperCase();
      const market = await database.query<{
        id: string; status: "active" | "restricted" | "pilot" | "disabled"; max_half_spread_bps: number;
        observed_at: Date | null; usdg_balance: string | null; oracle_tradable: boolean | null;
      }>(
        `SELECT m.id, m.status, m.max_half_spread_bps, s.observed_at, s.usdg_balance, s.oracle_tradable
         FROM public.markets m LEFT JOIN LATERAL (
           SELECT observed_at, usdg_balance, oracle_tradable FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
         ) s ON true WHERE m.symbol=$1`, [symbol]
      );
      const row = market.rows[0];
      if (!row) return response.status(404).json({ error: "market not found" });
      const quotes = await database.query<{ execution_degradation_bps: number }>(
        `SELECT execution_degradation_bps FROM public.quote_samples WHERE market_id=$1 AND observed_at=(
           SELECT q2.observed_at FROM public.quote_samples q2
           WHERE q2.market_id=$1
           GROUP BY q2.observed_at
           HAVING count(*) = 10
           ORDER BY q2.observed_at DESC LIMIT 1
         )`, [row.id]
      );
      const age = row.observed_at ? (Date.now() - row.observed_at.getTime()) / 1000 : null;
      const state = assessMarketRisk({
        marketStatus: row.status,
        maxHalfSpreadBps: row.max_half_spread_bps,
        quoteBps: quotes.rows.map((quote) => quote.execution_degradation_bps),
        oracleTradable: row.oracle_tradable,
        snapshotAgeSeconds: age,
        usdgBalance: row.usdg_balance === null ? null : BigInt(row.usdg_balance)
      }, maxPriceAgeSeconds);
      response.json({ market: symbol, snapshot_age_seconds: age, state });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
