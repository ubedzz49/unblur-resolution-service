import { Pool } from "pg";
import {
  Booking,
  BookingFilters,
  BookingStatus,
  CreateBookingInput,
  CreateRatingInput,
  CreateResolutionRequestInput,
  DuplicateAcceptedRequestError,
  DuplicateRatingError,
  Rating,
  ResolutionRepository,
  ResolutionRequest,
  ResolutionRequestFilters,
  ResolutionRequestStatus,
} from "./repository.js";

// postgres error code for a unique_violation -- used to turn the partial unique index's
// rejection into a clean DuplicateAcceptedRequestError instead of a raw DB error bubbling up
const UNIQUE_VIOLATION = "23505";

interface RequestRow {
  id: string;
  doubt_id: string;
  resolver_user_id: string;
  duration_mins: number;
  amount_cents: number;
  proposed_slots: string[];
  status: ResolutionRequestStatus;
  accepted_slot_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BookingRow {
  id: string;
  doubt_id: string;
  resolution_request_id: string;
  poster_user_id: string;
  resolver_user_id: string;
  slot_at: string;
  duration_mins: number;
  amount_cents: number;
  payment_id: string | null;
  provider_room_id: string | null;
  join_url: string | null;
  status: BookingStatus;
  completed_at: string | null;
  created_at: string;
}

interface RatingRow {
  id: string;
  booking_id: string;
  rater_user_id: string;
  rated_user_id: string;
  rating: number;
  feedback_text: string | null;
  created_at: string;
}

function toRequest(row: RequestRow): ResolutionRequest {
  return {
    id: row.id,
    doubtId: row.doubt_id,
    resolverUserId: row.resolver_user_id,
    durationMins: row.duration_mins,
    amountCents: row.amount_cents,
    proposedSlots: row.proposed_slots,
    status: row.status,
    acceptedSlotAt: row.accepted_slot_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    doubtId: row.doubt_id,
    resolutionRequestId: row.resolution_request_id,
    posterUserId: row.poster_user_id,
    resolverUserId: row.resolver_user_id,
    slotAt: row.slot_at,
    durationMins: row.duration_mins,
    amountCents: row.amount_cents,
    paymentId: row.payment_id,
    providerRoomId: row.provider_room_id,
    joinUrl: row.join_url,
    status: row.status,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function toRating(row: RatingRow): Rating {
  return {
    id: row.id,
    bookingId: row.booking_id,
    raterUserId: row.rater_user_id,
    ratedUserId: row.rated_user_id,
    rating: row.rating,
    feedbackText: row.feedback_text,
    createdAt: row.created_at,
  };
}

export class PostgresResolutionRepository implements ResolutionRepository {
  constructor(private pool: Pool) {}

  async createRequest(input: CreateResolutionRequestInput): Promise<ResolutionRequest> {
    const result = await this.pool.query<RequestRow>(
      `INSERT INTO resolution_requests (doubt_id, resolver_user_id, duration_mins, amount_cents, proposed_slots)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.doubtId, input.resolverUserId, input.durationMins, input.amountCents, JSON.stringify(input.proposedSlots)],
    );
    return toRequest(result.rows[0]);
  }

  async getRequestById(id: string): Promise<ResolutionRequest | null> {
    const result = await this.pool.query<RequestRow>(`SELECT * FROM resolution_requests WHERE id = $1`, [id]);
    return result.rows[0] ? toRequest(result.rows[0]) : null;
  }

  async listRequests(filters: ResolutionRequestFilters): Promise<ResolutionRequest[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.doubtId) {
      params.push(filters.doubtId);
      conditions.push(`doubt_id = $${params.length}`);
    }
    if (filters.resolverUserId) {
      params.push(filters.resolverUserId);
      conditions.push(`resolver_user_id = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<RequestRow>(
      `SELECT * FROM resolution_requests ${where} ORDER BY created_at DESC`,
      params,
    );
    return result.rows.map(toRequest);
  }

  async acceptRequest(requestId: string, chosenSlot: string, bookingInput: CreateBookingInput): Promise<Booking> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const updateResult = await client.query<RequestRow>(
        `UPDATE resolution_requests
         SET status = 'accepted', accepted_slot_at = $2, updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [requestId, chosenSlot],
      );
      if (!updateResult.rows[0]) {
        throw new Error("resolution request not found");
      }

      const bookingResult = await client.query<BookingRow>(
        `INSERT INTO bookings (doubt_id, resolution_request_id, poster_user_id, resolver_user_id, slot_at, duration_mins, amount_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          bookingInput.doubtId,
          bookingInput.resolutionRequestId,
          bookingInput.posterUserId,
          bookingInput.resolverUserId,
          bookingInput.slotAt,
          bookingInput.durationMins,
          bookingInput.amountCents,
        ],
      );

      await client.query("COMMIT");
      return toBooking(bookingResult.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      // the partial unique index on (doubt_id) WHERE status = 'accepted' rejects a concurrent
      // second accept for the same doubt -- turn that into a typed error, not a raw pg error
      if (isUniqueViolation(err)) {
        throw new DuplicateAcceptedRequestError(bookingInput.doubtId);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async rejectRequest(id: string): Promise<ResolutionRequest | null> {
    const result = await this.pool.query<RequestRow>(
      `UPDATE resolution_requests SET status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    return result.rows[0] ? toRequest(result.rows[0]) : null;
  }

  async setBookingPaymentId(bookingId: string, paymentId: string): Promise<Booking | null> {
    const result = await this.pool.query<BookingRow>(
      `UPDATE bookings SET payment_id = $2 WHERE id = $1 RETURNING *`,
      [bookingId, paymentId],
    );
    return result.rows[0] ? toBooking(result.rows[0]) : null;
  }

  async setBookingMeetingInfo(bookingId: string, providerRoomId: string, joinUrl: string): Promise<Booking | null> {
    const result = await this.pool.query<BookingRow>(
      `UPDATE bookings SET provider_room_id = $2, join_url = $3 WHERE id = $1 RETURNING *`,
      [bookingId, providerRoomId, joinUrl],
    );
    return result.rows[0] ? toBooking(result.rows[0]) : null;
  }

  async getBookingById(id: string): Promise<Booking | null> {
    const result = await this.pool.query<BookingRow>(`SELECT * FROM bookings WHERE id = $1`, [id]);
    return result.rows[0] ? toBooking(result.rows[0]) : null;
  }

  async listBookings(filters: BookingFilters): Promise<Booking[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.posterUserId) {
      params.push(filters.posterUserId);
      conditions.push(`poster_user_id = $${params.length}`);
    }
    if (filters.resolverUserId) {
      params.push(filters.resolverUserId);
      conditions.push(`resolver_user_id = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<BookingRow>(`SELECT * FROM bookings ${where} ORDER BY created_at DESC`, params);
    return result.rows.map(toBooking);
  }

  async completeBooking(id: string): Promise<Booking | null> {
    const result = await this.pool.query<BookingRow>(
      `UPDATE bookings SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    return result.rows[0] ? toBooking(result.rows[0]) : null;
  }

  async cancelBooking(id: string): Promise<Booking | null> {
    const result = await this.pool.query<BookingRow>(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [id],
    );
    return result.rows[0] ? toBooking(result.rows[0]) : null;
  }

  async createRating(input: CreateRatingInput): Promise<Rating> {
    try {
      const result = await this.pool.query<RatingRow>(
        `INSERT INTO ratings (booking_id, rater_user_id, rated_user_id, rating, feedback_text)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [input.bookingId, input.raterUserId, input.ratedUserId, input.rating, input.feedbackText],
      );
      return toRating(result.rows[0]);
    } catch (err) {
      // the unique index on ratings.booking_id rejects a second rating for the same booking --
      // turn that into a typed error, not a raw pg error
      if (isUniqueViolation(err)) {
        throw new DuplicateRatingError(input.bookingId);
      }
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === UNIQUE_VIOLATION;
}
