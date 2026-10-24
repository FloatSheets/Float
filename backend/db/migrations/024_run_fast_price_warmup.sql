ALTER TABLE markets
  ADD COLUMN reference_min_window_points INTEGER
  CHECK (reference_min_window_points IS NULL OR reference_min_window_points BETWEEN 1 AND 500);

-- Keep the accelerated launch exception isolated to RUN. The quote still has
-- to come from Robinhood and pass the per-market spread and solvency checks.
UPDATE markets
SET reference_min_window_points = 1,
    updated_at = now()
WHERE symbol = 'RUN';
