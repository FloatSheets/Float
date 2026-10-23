-- One owner reminder per closure window and action (apply the 3x closure
-- profile before a weekend or holiday, restore the launch profile after).
CREATE TABLE IF NOT EXISTS copper_closure_reminders (
  anchor_at TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('apply_closure', 'restore_launch')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (anchor_at, action)
);
