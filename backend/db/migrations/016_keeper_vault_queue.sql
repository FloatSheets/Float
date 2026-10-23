-- Durable, cross-instance lease and execution history for daily LP queue work.
CREATE TABLE IF NOT EXISTS keeper_vault_queue_runs (
  contract_version TEXT NOT NULL,
  epoch BIGINT NOT NULL CHECK (epoch >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'retry', 'completed')),
  lease_until TIMESTAMPTZ NOT NULL DEFAULT now(),
  settle_transaction_hash TEXT,
  next_epoch_transaction_hash TEXT,
  last_error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (contract_version, epoch)
);

CREATE INDEX IF NOT EXISTS keeper_vault_queue_runs_updated_at_idx
  ON keeper_vault_queue_runs(updated_at DESC);
