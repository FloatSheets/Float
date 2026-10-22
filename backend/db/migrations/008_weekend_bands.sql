-- Price bands held while a market's underlying cannot trade (weekends and NYSE
-- holidays). Prices are stored as 18-decimal USDG integers to match the oracle.
CREATE TABLE IF NOT EXISTS weekend_bands (
  symbol TEXT NOT NULL,
  anchor_at TIMESTAMPTZ NOT NULL,
  anchor_price_e18 NUMERIC(78, 0) NOT NULL CHECK (anchor_price_e18 > 0),
  center_price_e18 NUMERIC(78, 0) NOT NULL CHECK (center_price_e18 > 0),
  band_bps INTEGER NOT NULL CHECK (band_bps > 0 AND band_bps < 10000),
  shifts_up INTEGER NOT NULL DEFAULT 0,
  shifts_down INTEGER NOT NULL DEFAULT 0,
  outside_direction TEXT CHECK (outside_direction IN ('above', 'below')),
  outside_since TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, anchor_at)
);
