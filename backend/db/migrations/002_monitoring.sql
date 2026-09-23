CREATE TYPE monitor_run_status AS ENUM ('running', 'succeeded', 'partial_failure', 'failed');

CREATE TABLE monitor_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status monitor_run_status NOT NULL DEFAULT 'running',
  markets_attempted INTEGER NOT NULL DEFAULT 0,
  markets_succeeded INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE monitor_failures (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES monitor_runs(id) ON DELETE CASCADE,
  market_id BIGINT REFERENCES markets(id) ON DELETE SET NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_message TEXT NOT NULL
);

CREATE INDEX pool_snapshots_market_observed_at_idx ON pool_snapshots (market_id, observed_at DESC);
CREATE INDEX quote_samples_market_observed_at_idx ON quote_samples (market_id, observed_at DESC);
CREATE INDEX monitor_failures_run_id_idx ON monitor_failures (run_id);
