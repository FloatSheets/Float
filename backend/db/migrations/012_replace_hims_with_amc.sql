-- Retain HIMS observations for historical links while removing it from current
-- listings. AMC replaces HIMS's empty Goldlake market slot.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS listed BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE markets
SET status = 'disabled', listed = FALSE, updated_at = now()
WHERE symbol = 'HIMS';

INSERT INTO markets (
  symbol,
  uniswap_v3_pool_address,
  uniswap_v3_fee_tier,
  status,
  max_leverage,
  max_ticket_usdg,
  min_half_spread_bps,
  max_half_spread_bps,
  listed
)
VALUES (
  'AMC',
  '0xaa34fea710a1a737840329051d81d3b0b7c564d5',
  3000,
  'active',
  2,
  1000,
  30,
  75,
  TRUE
)
ON CONFLICT (symbol) DO UPDATE SET
  uniswap_v3_pool_address = EXCLUDED.uniswap_v3_pool_address,
  uniswap_v3_fee_tier = EXCLUDED.uniswap_v3_fee_tier,
  status = EXCLUDED.status,
  max_leverage = EXCLUDED.max_leverage,
  max_ticket_usdg = EXCLUDED.max_ticket_usdg,
  min_half_spread_bps = EXCLUDED.min_half_spread_bps,
  max_half_spread_bps = EXCLUDED.max_half_spread_bps,
  listed = TRUE,
  updated_at = now();
