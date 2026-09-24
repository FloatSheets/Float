export const historyRanges: Record<string, { seconds: number; bucket: number }> = {
  '1H': { seconds: 3600, bucket: 60 },
  '4H': { seconds: 14400, bucket: 300 },
  '1D': { seconds: 86400, bucket: 900 },
  '1W': { seconds: 604800, bucket: 7200 },
  '1M': { seconds: 2592000, bucket: 28800 },
};

// Aggregate the entire selected window, not just its first/last 500 samples.
// Missing buckets stay missing: no fabricated candles or exchange volume.
export const candleHistorySql = `
  WITH samples AS (
    SELECT s.observed_at, COALESCE(s.twap_price_usdg, s.spot_price_usdg) AS price,
           floor(extract(epoch FROM s.observed_at) / $3::integer) * $3::integer AS bucket
    FROM public.pool_snapshots s JOIN public.markets m ON m.id=s.market_id
    WHERE m.symbol=$1 AND s.observed_at >= now() - ($2::text || ' seconds')::interval
      AND s.observed_at <= now() AND COALESCE(s.twap_price_usdg, s.spot_price_usdg) > 0
  )
  SELECT to_timestamp(bucket::double precision) AS time,
         (array_agg(price ORDER BY observed_at))[1]::text AS open,
         max(price)::text AS high, min(price)::text AS low,
         (array_agg(price ORDER BY observed_at DESC))[1]::text AS close,
         count(*)::integer AS samples, max(observed_at) AS last_observed_at
  FROM samples GROUP BY bucket ORDER BY bucket ASC`;
