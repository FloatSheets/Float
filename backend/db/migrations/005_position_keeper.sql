-- The clearing house does not enumerate positions. The keeper discovers
-- trader/market pairs from TradeExecuted logs and keeps them until closed.
CREATE TABLE IF NOT EXISTS keeper_cursors (
  contract_version TEXT PRIMARY KEY,
  next_block BIGINT NOT NULL CHECK (next_block >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS keeper_positions (
  contract_version TEXT NOT NULL,
  trader TEXT NOT NULL CHECK (trader ~ '^0x[0-9a-f]{40}$'),
  market_id TEXT NOT NULL CHECK (market_id ~ '^0x[0-9a-f]{64}$'),
  first_seen_block BIGINT NOT NULL,
  last_checked_at TIMESTAMPTZ,
  PRIMARY KEY (contract_version, trader, market_id)
);

CREATE TABLE IF NOT EXISTS keeper_actions (
  id BIGSERIAL PRIMARY KEY,
  contract_version TEXT NOT NULL,
  trader TEXT NOT NULL,
  market_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('liquidation', 'expiry')),
  transaction_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS keeper_actions_created_at_idx ON keeper_actions(created_at DESC);
