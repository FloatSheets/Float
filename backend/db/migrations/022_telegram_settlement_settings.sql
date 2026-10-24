CREATE TABLE telegram_vault_settings_challenges (
  wallet_address text PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  enabled boolean NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL
);
