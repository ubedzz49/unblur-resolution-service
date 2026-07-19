# unblur-resolution-service

Resolution requests and bookings. Owns the `resolution_requests` and `bookings` tables.

A resolver sends a resolution request against an open doubt (proposed duration, price, and
candidate time slots). The doubt's author accepts or rejects it; accepting closes the doubt,
creates a booking, and collects payment. Either party can later mark the booking complete
(updating the resolver's minutes-resolved stat) or cancel it (refunding if a payment was taken).

## Service dependencies

Calls three sibling services directly over HTTP (same pattern as `doubt-service`'s
`MatchingClient` calling `matching-service` directly), not through the gateway:

- **Doubt Service** (`DOUBT_SERVICE_URL`) — fetch a doubt, close it on accept. No graceful
  degradation: a resolution request or booking without a real underlying doubt is meaningless,
  so a failed call here throws and the request fails.
- **Payment Service** (`PAYMENT_SERVICE_URL`) — collect payment on accept, refund on cancel.
  Authenticated via the shared `INTERNAL_SERVICE_TOKEN` (sent as `X-Internal-Service-Token`),
  not a user JWT. No graceful degradation here either — a booking without a real payment record,
  or a cancel that silently fails to refund, is a real money problem.
- **User Service** (`USER_SERVICE_URL`) — increment the resolver's `minutesResolved` stat on
  booking completion. Same internal-token auth. Unlike the two clients above, **this one
  degrades gracefully**: a stats-update failure is logged as a warning and does not block the
  booking from completing. The booking completing is what matters; a stats hiccup can be
  reconciled later.

## Auth

Every route reads the caller's identity from the `X-User-Id` header, set by the gateway after it
verifies the caller's JWT. This service does not verify JWTs itself (see
`ARCHITECTURE_DECISIONS.md`'s gateway-trust decision). A missing header returns
`401 { error: "missing X-User-Id header" }` — this should never happen in production traffic
through the gateway, but the service defends against it anyway.

## One accepted request per doubt

`resolution_requests` has a partial unique index on `doubt_id WHERE status = 'accepted'`. The
app layer also checks defensively before accepting (to return a clean error in the common case),
but the index is the actual guarantee against a race between two concurrent accepts for the same
doubt — a caught unique-violation is turned into a `409`, never a raw DB error.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

## Scripts

- `npm run dev` — local dev server
- `npm run build` — production build
- `npm run migrate` — run pending migrations
- `npm test` — unit tests (Vitest)
