-- FloatSheets Copper: perps on the 10 lowest-market-cap official Robinhood Stock
-- Tokens (snapshot 2026-10-22, stockanalysis.com market caps). Their Uniswap pools are
-- empty or a few thousand USDG deep, so these markets are priced from reference
-- quotes (Robinhood's own Stock Token quotes, Pyth equity feeds, and the Uniswap pool
-- only where it is deep enough) instead of pool TWAP alone.

-- 1. Price source and release membership ------------------------------------------------
ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS price_source TEXT NOT NULL DEFAULT 'uniswap_v3'
    CHECK (price_source IN ('uniswap_v3', 'reference')),
  -- Releases whose dashboards list this market. Rows default to the large-cap release.
  ADD COLUMN IF NOT EXISTS releases TEXT[] NOT NULL DEFAULT '{goldlake}',
  ADD COLUMN IF NOT EXISTS listing_class TEXT NOT NULL DEFAULT 'large_cap'
    CHECK (listing_class IN ('large_cap', 'penny')),
  -- The oracle's breaker band and jump guard for this market (50 / 2000 = FloatOracle constants).
  ADD COLUMN IF NOT EXISTS max_spot_twap_deviation_bps INTEGER NOT NULL DEFAULT 50
    CHECK (max_spot_twap_deviation_bps BETWEEN 10 AND 1500),
  ADD COLUMN IF NOT EXISTS max_price_jump_bps INTEGER NOT NULL DEFAULT 2000
    CHECK (max_price_jump_bps BETWEEN 500 AND 5000),
  -- Official Stock Token contract (a Robinhood beacon proxy; impostor tokens reuse the
  -- same name and symbol, so never trust a token found by symbol alone).
  ADD COLUMN IF NOT EXISTS token_address TEXT CHECK (token_address IS NULL OR token_address ~ '^0x[0-9a-fA-F]{40}$'),
  ADD COLUMN IF NOT EXISTS pyth_feed_id TEXT CHECK (pyth_feed_id IS NULL OR pyth_feed_id ~ '^[0-9a-f]{64}$'),
  -- Fresh, agreeing sources needed before new positions are quoted. Closes need one.
  ADD COLUMN IF NOT EXISTS min_sources_for_open INTEGER NOT NULL DEFAULT 2
    CHECK (min_sources_for_open BETWEEN 1 AND 3),
  ADD COLUMN IF NOT EXISTS market_cap_usd NUMERIC(20, 2),
  ADD COLUMN IF NOT EXISTS market_cap_as_of DATE;

ALTER TABLE markets ALTER COLUMN uniswap_v3_pool_address DROP NOT NULL;
ALTER TABLE markets ALTER COLUMN uniswap_v3_fee_tier DROP NOT NULL;
ALTER TABLE markets DROP CONSTRAINT IF EXISTS markets_price_source_fields;
ALTER TABLE markets ADD CONSTRAINT markets_price_source_fields CHECK (
  (price_source = 'uniswap_v3' AND uniswap_v3_pool_address IS NOT NULL AND uniswap_v3_fee_tier IS NOT NULL)
  OR (price_source = 'reference' AND token_address IS NOT NULL)
);

-- 2. Snapshot provenance -------------------------------------------------------------------
ALTER TABLE pool_snapshots
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'uniswap_v3' CHECK (source IN ('uniswap_v3', 'reference')),
  ADD COLUMN IF NOT EXISTS sources_used INTEGER,
  ADD COLUMN IF NOT EXISTS source_dispersion_bps INTEGER,
  ADD COLUMN IF NOT EXISTS frozen_reason TEXT,
  -- Reference markets: publish with the on-chain breaker set (halt, paused token, held mark).
  ADD COLUMN IF NOT EXISTS oracle_frozen BOOLEAN NOT NULL DEFAULT FALSE,
  -- Reference markets: the 15-minute average that gates opens (the published mark is the live mid).
  ADD COLUMN IF NOT EXISTS reference_average_usdg NUMERIC(38, 18);

-- Every raw quote the reference monitor saw, for audit and the public oracle page.
CREATE TABLE IF NOT EXISTS reference_quotes (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL CHECK (source IN ('robinhood', 'pyth')),
  bid_usdg NUMERIC(38, 18),
  ask_usdg NUMERIC(38, 18),
  mid_usdg NUMERIC(38, 18) NOT NULL CHECK (mid_usdg > 0),
  source_time TIMESTAMPTZ NOT NULL,
  halted BOOLEAN NOT NULL DEFAULT FALSE,
  used BOOLEAN NOT NULL,
  reject_reason TEXT
);
CREATE INDEX IF NOT EXISTS reference_quotes_market_time ON reference_quotes (market_id, observed_at DESC);

-- 3. The Copper markets ----------------------------------------------------------------------
-- tier 1 (Robinhood + Pyth): 5x launch, $1,000 cap, two agreeing sources to open.
-- tier 2 (Robinhood only):   5x launch, $500 cap, one source to open.
-- Oracle thresholds are the stock FloatOracle values (50 bps band, 20% jump guard):
-- reference marks publish spot equal to the mark, and larger gaps are walked in steps.
-- The published mark is the live reference mid; quotes add the Robinhood half spread (or the
-- market floor) plus a small size impact. Frozen markets quote closes at 700 bps.
INSERT INTO markets (
  symbol, uniswap_v3_pool_address, uniswap_v3_fee_tier, status, max_leverage, max_ticket_usdg,
  min_half_spread_bps, max_half_spread_bps, listed, price_source, releases, listing_class,
  max_spot_twap_deviation_bps, max_price_jump_bps, token_address, pyth_feed_id, min_sources_for_open,
  market_cap_usd, market_cap_as_of
) VALUES
  ('WYFI', NULL, NULL, 'active', 5, 500, 60, 300, TRUE, 'reference', '{copper}', 'penny', 50, 2000,
   '0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E', NULL, 1, 410620000, '2026-10-22'),
  ('NNE', NULL, NULL, 'active', 5, 1000, 50, 200, TRUE, 'reference', '{copper}', 'penny', 50, 2000,
   '0xBEF75684C43c4ea7BD18Dd532a2244674Ee8b926', 'a6fa5a4d8c9b0eb54f314df24f62382d0fd7817a0aebba8bcf5a8de833cac21d', 2, 683580000, '2026-10-22'),
  ('RCAT', '0x64710a70839585af718e1b1faef9e7f1665f1116', 10000, 'active', 5, 1000, 50, 200, TRUE, 'reference', '{copper}', 'penny', 50, 2000,
   '0xFDE6b5d9BB419B10C23268c74e369AbFF39C0460', 'bd4cb54e777668772c77d2824b44262580ed6efa000f612405a13b3c515584bb', 2, 685690000, '2026-10-22'),
  ('TE', NULL, NULL, 'active', 5, 500, 60, 300, TRUE, 'reference', '{copper}', 'penny', 50, 2000,
   '0xb1969f6604ca1ae7a2cd3f1827876e914594ca2d', NULL, 1, 700850000, '2026-10-22'),
  ('XNDU', NULL, NULL, 'active', 5, 1000, 50, 200, TRUE, 'reference', '{copper}', 'penny', 50, 2000,
   '0xa8eb3bccbf2017ee7cbfb652eb51cf2e1b153289', '6ef46b572312904a787261fdd628e70a558d36ec8a350d9f4e19443dab07124b', 2, 832800000, '2026-10-22'),
  ('POET', NULL, NULL, 'active', 5, 1000, 50, 200, TRUE, 'reference', '{copper}', 'penny', 50, 2000,
   '0xcf6b2d875361be807eafa57458c80f28521f9333', 'd44395eb9a32dd0203793e12ccd0da18fde61bc7710b6ca6f33d56f307d14cdb', 2, 929200000, '2026-10-22'),
  ('FLNC', NULL, NULL, 'active', 5, 1000, 50, 200, TRUE, 'reference', '{copper}', 'penny', 50, 2000,
   '0x282e87451e10fa6679bc7d76c69be44cd3fc777c', '800415fb1fa6bac6bd13888d85843015a9cf35df23769314eb2ccad6b198ac4f', 2, 1060000000, '2026-10-22'),
  ('RUN', NULL, NULL, 'active', 5, 500, 60, 300, TRUE, 'reference', '{copper}', 'penny', 50, 2000,
   '0x756Bc80af765C82da966a788858d65aDF14f3793', NULL, 1, 1820000000, '2026-10-22'),
  ('DJT', '0x31a89afd92f9397465649ad03226c52292fc1ae5', 10000, 'active', 5, 1000, 50, 200, TRUE, 'reference', '{copper}', 'penny', 50, 2000,
   '0x1d11f0496982706c5e14a514d4e79f2e6bde4516', 'cabf6dfb723b12ac8a67e919379d177903580f8d3ae2fad3897198dc07a5a861', 2, 1850000000, '2026-10-22')
ON CONFLICT (symbol) DO UPDATE SET
  uniswap_v3_pool_address = EXCLUDED.uniswap_v3_pool_address,
  uniswap_v3_fee_tier = EXCLUDED.uniswap_v3_fee_tier,
  status = EXCLUDED.status,
  max_leverage = EXCLUDED.max_leverage,
  max_ticket_usdg = EXCLUDED.max_ticket_usdg,
  min_half_spread_bps = EXCLUDED.min_half_spread_bps,
  max_half_spread_bps = EXCLUDED.max_half_spread_bps,
  listed = TRUE,
  price_source = EXCLUDED.price_source,
  releases = EXCLUDED.releases,
  listing_class = EXCLUDED.listing_class,
  max_spot_twap_deviation_bps = EXCLUDED.max_spot_twap_deviation_bps,
  max_price_jump_bps = EXCLUDED.max_price_jump_bps,
  token_address = EXCLUDED.token_address,
  pyth_feed_id = EXCLUDED.pyth_feed_id,
  min_sources_for_open = EXCLUDED.min_sources_for_open,
  market_cap_usd = EXCLUDED.market_cap_usd,
  market_cap_as_of = EXCLUDED.market_cap_as_of,
  updated_at = now();

-- QUBT is already listed on Goldlake (close-only there). It joins Copper with the same
-- row. Its Uniswap pool is kept for display only: pools are not reference price sources.
UPDATE markets SET
  price_source = 'reference',
  releases = '{goldlake,copper}',
  listing_class = 'penny',
  max_leverage = 5,
  max_ticket_usdg = 1000,
  min_half_spread_bps = 50,
  max_half_spread_bps = 200,
  max_spot_twap_deviation_bps = 50,
  max_price_jump_bps = 2000,
  token_address = '0x59818904ab4ce163b3ce4ffb64f2d6ca02c434b4',
  pyth_feed_id = '35df6acc91ade17065f757233443edee7b5046a4cd65748641f48d1c78e031b3',
  min_sources_for_open = 2,
  market_cap_usd = 1520000000,
  market_cap_as_of = '2026-10-22',
  updated_at = now()
WHERE symbol = 'QUBT';
