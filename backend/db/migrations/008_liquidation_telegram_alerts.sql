CREATE TABLE IF NOT EXISTS liquidation_telegram_wallet_challenges (
  wallet_address TEXT PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  message TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('link', 'enable', 'disable')),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS liquidation_telegram_link_codes (
  token_hash TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  linked_at TIMESTAMPTZ,
  telegram_chat_id TEXT,
  telegram_username TEXT
);

CREATE INDEX IF NOT EXISTS liquidation_telegram_link_codes_expiry_idx
  ON liquidation_telegram_link_codes(expires_at);

CREATE TABLE IF NOT EXISTS liquidation_telegram_links (
  wallet_address TEXT PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  telegram_chat_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_bot_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  next_update_id BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS liquidation_alert_deliveries (
  event_key TEXT NOT NULL REFERENCES liquidation_alert_events(event_key) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'telegram')),
  recipient_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(event_key, channel, recipient_key)
);

INSERT INTO telegram_bot_state(singleton, next_update_id) VALUES(true, 0)
ON CONFLICT(singleton) DO NOTHING;
