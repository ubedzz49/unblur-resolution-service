-- Resolver-specific join link (tagged with their user id via a Daily meeting token) so a
-- participant's session can actually be attributed to them, plus the real attendance recorded
-- at booking-completion time -- both needed for the resolver-attendance-gated payout rule.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resolver_join_url TEXT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS attended_seconds INTEGER NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS attendance_ratio NUMERIC(5,4) NULL;
