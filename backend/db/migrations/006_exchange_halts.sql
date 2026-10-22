-- Listing-exchange trading halts mirrored from the Nasdaq Trader halt feed.
-- A halted underlying makes the market close-only until trading resumes.
CREATE TABLE IF NOT EXISTS exchange_halts (
  symbol TEXT NOT NULL,
  halted_at TIMESTAMPTZ NOT NULL,
  listing_market TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  resumption_trade_at TIMESTAMPTZ,
  -- True while the halt is listed in the latest successful feed read and has
  -- not reached its resumption trade time.
  active BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, halted_at)
);

CREATE INDEX IF NOT EXISTS exchange_halts_active_idx ON exchange_halts(symbol) WHERE active;

CREATE TABLE IF NOT EXISTS exchange_halt_feed (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
