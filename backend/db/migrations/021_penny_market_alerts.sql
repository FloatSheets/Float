-- Telegram chats that opted in to penny-market halt and pause alerts (/pennyalerts on).
-- Market status is public, so no linked wallet is required.
CREATE TABLE IF NOT EXISTS penny_alert_subscriptions (
  telegram_chat_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Last observed trading state per penny market, so alerts fire on changes only.
CREATE TABLE IF NOT EXISTS penny_market_alert_state (
  symbol TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('live', 'halt', 'pause', 'quiet')),
  reason TEXT,
  since TIMESTAMPTZ NOT NULL,
  alerted BOOLEAN NOT NULL DEFAULT false,
  last_alerted_state TEXT CHECK (last_alerted_state IN ('live', 'halt', 'pause'))
);
