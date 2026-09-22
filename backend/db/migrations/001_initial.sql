CREATE TYPE market_status AS ENUM ('active', 'restricted', 'pilot', 'disabled');

CREATE TABLE markets (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  settlement_asset TEXT NOT NULL DEFAULT 'USDG',
  uniswap_v3_pool_address TEXT NOT NULL UNIQUE,
  uniswap_v3_fee_tier INTEGER NOT NULL CHECK (uniswap_v3_fee_tier IN (100, 500, 3000, 10000)),
  status market_status NOT NULL,
  max_leverage NUMERIC(5, 2) NOT NULL CHECK (max_leverage > 0),
  max_ticket_usdg NUMERIC(20, 6) NOT NULL CHECK (max_ticket_usdg > 0),
  min_half_spread_bps INTEGER NOT NULL CHECK (min_half_spread_bps >= 0),
  max_half_spread_bps INTEGER NOT NULL CHECK (max_half_spread_bps >= min_half_spread_bps),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pool_snapshots (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sqrt_price_x96 NUMERIC(78, 0) NOT NULL,
  liquidity NUMERIC(78, 0) NOT NULL,
  usdg_balance NUMERIC(38, 0) NOT NULL,
  UNIQUE (market_id, observed_at)
);

CREATE TABLE quote_samples (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notional_usdg NUMERIC(20, 6) NOT NULL CHECK (notional_usdg > 0),
  direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  quoted_output NUMERIC(38, 0) NOT NULL,
  execution_degradation_bps INTEGER NOT NULL,
  UNIQUE (market_id, observed_at, notional_usdg, direction)
);

INSERT INTO markets (symbol, uniswap_v3_pool_address, uniswap_v3_fee_tier, status, max_leverage, max_ticket_usdg, min_half_spread_bps, max_half_spread_bps)
VALUES
  ('NVDA', '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3', 500, 'active', 5, 50000, 15, 30),
  ('SPCX', '0xc61284332117c3fb23a2a56cceffd07f7af60029', 500, 'active', 5, 50000, 15, 30),
  ('CRCL', '0x654e4143e82a5824445ade0824351c2a9acd95a8', 3000, 'active', 4, 25000, 40, 80),
  ('HIMS', '0xc8c90d3a1c1a24967e773ac2ad0d456ba3e31f64', 3000, 'active', 4, 25000, 40, 80),
  ('MU', '0xd057b1bc54917855bbee58ead58647f47cab35e5', 3000, 'active', 3, 10000, 50, 150),
  ('TSLA', '0xf4acdaeeb7022862a763c9b1b885e11191c889e3', 3000, 'active', 3, 10000, 50, 150),
  ('RDDT', '0xa8744e76aed23b05f0126335e7bd38f7935d19fe', 10000, 'active', 2, 5000, 125, 300),
  ('MSTR', '0x17578c0e0d15da44f31677263114f71ae76653ea', 10000, 'active', 2, 5000, 125, 300),
  ('PLTR', '0x851680416a4f4e1c463d45171d61acddbc8554c0', 3000, 'restricted', 2, 10000, 75, 500),
  ('QUBT', '0x227bbce9a81b3694b01754298a983be3f9e44a93', 3000, 'pilot', 2, 1000, 100, 750);
