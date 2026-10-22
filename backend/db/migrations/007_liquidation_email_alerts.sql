CREATE TABLE IF NOT EXISTS liquidation_email_preferences (
  wallet_address TEXT PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  email TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ,
  verification_token_hash TEXT,
  verification_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS liquidation_email_challenges (
  wallet_address TEXT PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS liquidation_alert_cursors (
  contract_version TEXT PRIMARY KEY,
  next_block BIGINT NOT NULL CHECK (next_block >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS liquidation_alert_events (
  event_key TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  trader TEXT NOT NULL,
  market_id TEXT NOT NULL,
  price_e18 NUMERIC(78,0) NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS liquidation_alert_events_pending_idx
  ON liquidation_alert_events(created_at) WHERE sent_at IS NULL;
