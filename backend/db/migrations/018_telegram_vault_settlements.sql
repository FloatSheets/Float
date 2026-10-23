CREATE TABLE telegram_vault_subscriptions (
  wallet_address text PRIMARY KEY REFERENCES liquidation_telegram_links(wallet_address) ON DELETE CASCADE,
  telegram_chat_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  vault_address text NOT NULL,
  next_epoch bigint NOT NULL DEFAULT 0 CHECK (next_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE telegram_vault_deliveries (
  wallet_address text NOT NULL,
  telegram_chat_id text NOT NULL,
  vault_address text NOT NULL,
  epoch bigint NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, telegram_chat_id, vault_address, epoch)
);
