-- Opening quotes signed while a market's underlying is closed. Each counts
-- toward the wallet's weekend allowance once executed, or while unexpired.
CREATE TABLE IF NOT EXISTS weekend_quotes (
  id BIGSERIAL PRIMARY KEY,
  clearing_house TEXT NOT NULL,
  trader TEXT NOT NULL CHECK (trader ~ '^0x[0-9a-f]{40}$'),
  symbol TEXT NOT NULL,
  anchor_at TIMESTAMPTZ NOT NULL,
  nonce NUMERIC(20, 0) NOT NULL,
  notional_usdg NUMERIC(38, 0) NOT NULL CHECK (notional_usdg > 0),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  -- NULL until the quote expires and its on-chain nonce has been checked.
  executed BOOLEAN,
  UNIQUE (clearing_house, trader, nonce)
);

CREATE INDEX IF NOT EXISTS weekend_quotes_wallet_idx ON weekend_quotes(clearing_house, trader, symbol, anchor_at);
