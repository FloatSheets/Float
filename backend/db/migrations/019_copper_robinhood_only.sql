-- Copper prices from Robinhood's own Stock Token quotes. Every penny market opens
-- on one live Robinhood quote; Pyth (when the API plan covers US equities) still
-- joins as a cross-check, and a disagreement between live sources still blocks opens.
UPDATE markets SET min_sources_for_open = 1, updated_at = now()
WHERE 'copper' = ANY(releases) AND price_source = 'reference';
