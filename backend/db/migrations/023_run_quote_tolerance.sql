ALTER TABLE markets
  ADD COLUMN max_unchanged_quote_seconds INTEGER NOT NULL DEFAULT 3600
  CHECK (max_unchanged_quote_seconds BETWEEN 60 AND 86400);

-- RUN's Robinhood quote can remain unchanged for long stretches. Permit a
-- current provider heartbeat for up to a day, and widen the execution-quality
-- ceiling enough to accept its current market while keeping the contract bound.
UPDATE markets
SET max_half_spread_bps = 500,
    max_unchanged_quote_seconds = 86400,
    updated_at = now()
WHERE symbol = 'RUN';
