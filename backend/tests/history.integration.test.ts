import 'dotenv/config';
import { expect, test } from 'bun:test';
import { db } from '../src/db';
import { candleHistorySql, historyRanges } from '../src/markets/history';

test('OHLC covers the entire recorded window and includes the newest observation', async()=>{
  const client=await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for(const range of ['1H','1D','1M']){
      const {seconds,bucket}=historyRanges[range]!;
      const candles=await client.query(candleHistorySql,['NVDA',String(seconds),bucket]);
      const samples=await client.query(`SELECT s.observed_at, COALESCE(s.twap_price_usdg,s.spot_price_usdg)::text AS price
        FROM public.pool_snapshots s JOIN public.markets m ON m.id=s.market_id
        WHERE m.symbol='NVDA' AND s.observed_at>=now()-($1::text||' seconds')::interval
          AND s.observed_at<=now() AND COALESCE(s.twap_price_usdg,s.spot_price_usdg)>0 ORDER BY s.observed_at`,[String(seconds)]);
      // These are real recorded observations, never inserted test prices.
      expect(samples.rows.length).toBeGreaterThan(0);
      expect(candles.rows.reduce((n,c)=>n+c.samples,0)).toBe(samples.rows.length);
      expect(candles.rows.length).toBeLessThanOrEqual(Math.ceil(seconds/bucket)+1);
      for(const c of candles.rows){
        const group=samples.rows.filter(s=>Math.floor(new Date(s.observed_at).getTime()/1000/bucket)*bucket===new Date(c.time).getTime()/1000);
        expect(Number(c.open)).toBe(Number(group[0].price));
        expect(Number(c.close)).toBe(Number(group[group.length-1].price));
        expect(Number(c.high)).toBe(Math.max(...group.map(s=>Number(s.price))));
        expect(Number(c.low)).toBe(Math.min(...group.map(s=>Number(s.price))));
      }
      expect(new Date(candles.rows.at(-1).last_observed_at).getTime()).toBe(new Date(samples.rows.at(-1).observed_at).getTime());
    }
    expect((await client.query(candleHistorySql,['NOT_A_MARKET','3600',60])).rows).toEqual([]);
  } finally {await client.query('ROLLBACK');client.release();}
},60_000);
