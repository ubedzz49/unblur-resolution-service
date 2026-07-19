-- Shares the same RDS instance and database as the other unblur services (pragmatic reuse of
-- existing infra) -- but this service owns and only touches resolution_requests/bookings, never
-- the doubts/users/payments tables.

CREATE TABLE IF NOT EXISTS resolution_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- soft reference to doubt-service's doubts.id -- same physical DB but a different service's
  -- table, so no cross-db FK here
  doubt_id UUID NOT NULL,
  -- soft reference to user-service's users.id, same caveat as above
  resolver_user_id UUID NOT NULL,
  duration_mins INTEGER NOT NULL CHECK (duration_mins > 0 AND duration_mins <= 480),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  -- array of ISO timestamp strings; "at least one slot" is enforced in the app layer, not here
  proposed_slots JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  accepted_slot_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resolution_requests_doubt_status
  ON resolution_requests (doubt_id, status);

-- the actual guarantee behind "only one accepted request per doubt" -- app layer also checks
-- defensively before accepting, but this index is what stops the race under concurrent accepts
CREATE UNIQUE INDEX IF NOT EXISTS idx_resolution_requests_one_accepted_per_doubt
  ON resolution_requests (doubt_id) WHERE status = 'accepted';

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- soft reference to doubt-service's doubts.id, same caveat as resolution_requests.doubt_id
  doubt_id UUID NOT NULL,
  resolution_request_id UUID NOT NULL REFERENCES resolution_requests(id),
  -- soft references to user-service's users.id
  poster_user_id UUID NOT NULL,
  resolver_user_id UUID NOT NULL,
  slot_at TIMESTAMPTZ NOT NULL,
  duration_mins INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  -- soft reference to payment-service's payments.id, set once the payment call succeeds
  payment_id UUID NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_poster ON bookings (poster_user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_resolver ON bookings (resolver_user_id);
