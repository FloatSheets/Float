-- Upcoming splits and cash dividends for listed markets, mirrored from the
-- Nasdaq split and dividend calendars or entered by an administrator.
CREATE TABLE IF NOT EXISTS corporate_actions (
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('split', 'cash_dividend')),
  ex_date DATE NOT NULL,
  -- Splits: new shares per old share ("10 : 1" is 10 / 1; "1 : 10" is 1 / 10).
  split_new NUMERIC(20, 6),
  split_old NUMERIC(20, 6),
  -- Cash dividends: amount per share in USD.
  amount_usd NUMERIC(20, 6),
  source TEXT NOT NULL CHECK (source IN ('nasdaq', 'admin')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, kind, ex_date),
  CHECK (kind <> 'split' OR (split_new > 0 AND split_old > 0)),
  CHECK (kind <> 'cash_dividend' OR amount_usd > 0)
);

CREATE TABLE IF NOT EXISTS corporate_action_feed (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
