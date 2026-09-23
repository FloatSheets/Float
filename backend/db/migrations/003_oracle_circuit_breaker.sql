ALTER TABLE pool_snapshots
  ADD COLUMN twap_price_usdg NUMERIC(38, 18),
  ADD COLUMN spot_price_usdg NUMERIC(38, 18),
  ADD COLUMN spot_twap_deviation_bps INTEGER,
  ADD COLUMN oracle_tradable BOOLEAN;

ALTER TABLE pool_snapshots
  ADD CONSTRAINT pool_snapshots_spot_twap_deviation_bps_check
  CHECK (spot_twap_deviation_bps IS NULL OR spot_twap_deviation_bps >= 0);
