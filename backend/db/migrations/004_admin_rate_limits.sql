CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hit_count INTEGER NOT NULL CHECK (hit_count > 0),
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS api_rate_limits_window_start_idx ON api_rate_limits(window_start);
