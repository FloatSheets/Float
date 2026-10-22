-- One row per component per status check (about once a minute). Kept 90 days
-- for the public uptime history.
CREATE TABLE IF NOT EXISTS status_checks (
  id BIGSERIAL PRIMARY KEY,
  component TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('operational', 'degraded', 'outage')),
  detail TEXT
);

CREATE INDEX IF NOT EXISTS status_checks_component_time_idx ON status_checks(component, checked_at DESC);

-- Incidents open automatically after consecutive failed checks and resolve on
-- recovery. Administrators can add a post-mortem.
CREATE TABLE IF NOT EXISTS status_incidents (
  id BIGSERIAL PRIMARY KEY,
  component TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('degraded', 'outage')),
  title TEXT NOT NULL,
  detail TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  postmortem TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS status_incidents_one_open_idx ON status_incidents(component) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS status_incidents_started_idx ON status_incidents(started_at DESC);
