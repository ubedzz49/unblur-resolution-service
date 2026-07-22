-- meeting room info gets attached to a booking once the accept flow provisions a real room
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_room_id TEXT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS join_url TEXT NULL;

CREATE TABLE IF NOT EXISTS ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  -- soft reference to user-service's users.id, same caveat as bookings.poster_user_id/resolver_user_id
  rater_user_id UUID NOT NULL,
  rated_user_id UUID NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  feedback_text TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the actual guarantee behind "one rating per booking" -- app layer also checks the booking's
-- status before inserting, but this is what stops a race between two concurrent rate calls
CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_one_per_booking ON ratings (booking_id);
