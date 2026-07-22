export type ResolutionRequestStatus = "pending" | "accepted" | "rejected";
export type BookingStatus = "scheduled" | "completed" | "cancelled";

export interface ResolutionRequest {
  id: string;
  doubtId: string;
  resolverUserId: string;
  durationMins: number;
  amountCents: number;
  proposedSlots: string[];
  status: ResolutionRequestStatus;
  acceptedSlotAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateResolutionRequestInput {
  doubtId: string;
  resolverUserId: string;
  durationMins: number;
  amountCents: number;
  proposedSlots: string[];
}

export interface Booking {
  id: string;
  doubtId: string;
  resolutionRequestId: string;
  posterUserId: string;
  resolverUserId: string;
  slotAt: string;
  durationMins: number;
  amountCents: number;
  paymentId: string | null;
  providerRoomId: string | null;
  joinUrl: string | null;
  status: BookingStatus;
  completedAt: string | null;
  createdAt: string;
}

export interface Rating {
  id: string;
  bookingId: string;
  raterUserId: string;
  ratedUserId: string;
  rating: number;
  feedbackText: string | null;
  createdAt: string;
}

export interface CreateRatingInput {
  bookingId: string;
  raterUserId: string;
  ratedUserId: string;
  rating: number;
  feedbackText: string | null;
}

export interface CreateBookingInput {
  doubtId: string;
  resolutionRequestId: string;
  posterUserId: string;
  resolverUserId: string;
  slotAt: string;
  durationMins: number;
  amountCents: number;
}

export interface ResolutionRequestFilters {
  doubtId?: string;
  resolverUserId?: string;
  status?: ResolutionRequestStatus;
}

export interface BookingFilters {
  posterUserId?: string;
  resolverUserId?: string;
  status?: BookingStatus;
}

// thrown by acceptRequest when the DB's partial unique index (one accepted request per doubt)
// rejects the write -- callers turn this into a clean 409, never a raw DB error
export class DuplicateAcceptedRequestError extends Error {
  constructor(doubtId: string) {
    super(`doubt ${doubtId} already has an accepted resolution request`);
    this.name = "DuplicateAcceptedRequestError";
  }
}

// thrown by createRating when the DB's unique index on bookings.id (one rating per booking)
// rejects the write -- callers turn this into a clean 409, never a raw DB error
export class DuplicateRatingError extends Error {
  constructor(bookingId: string) {
    super(`booking ${bookingId} has already been rated`);
    this.name = "DuplicateRatingError";
  }
}

export interface ResolutionRepository {
  createRequest(input: CreateResolutionRequestInput): Promise<ResolutionRequest>;
  getRequestById(id: string): Promise<ResolutionRequest | null>;
  listRequests(filters: ResolutionRequestFilters): Promise<ResolutionRequest[]>;
  // moves a pending request to accepted + inserts the booking in one transaction; throws
  // DuplicateAcceptedRequestError if another request for the same doubt already won the race
  acceptRequest(requestId: string, chosenSlot: string, booking: CreateBookingInput): Promise<Booking>;
  rejectRequest(id: string): Promise<ResolutionRequest | null>;
  setBookingPaymentId(bookingId: string, paymentId: string): Promise<Booking | null>;
  setBookingMeetingInfo(bookingId: string, providerRoomId: string, joinUrl: string): Promise<Booking | null>;
  getBookingById(id: string): Promise<Booking | null>;
  listBookings(filters: BookingFilters): Promise<Booking[]>;
  completeBooking(id: string): Promise<Booking | null>;
  cancelBooking(id: string): Promise<Booking | null>;
  // throws DuplicateRatingError if the booking already has a rating
  createRating(input: CreateRatingInput): Promise<Rating>;
}

// test-only -- avoids CI needing real Postgres
export class InMemoryResolutionRepository implements ResolutionRepository {
  private requests = new Map<string, ResolutionRequest>();
  private bookings = new Map<string, Booking>();
  // mirrors the DB's unique index on ratings.booking_id
  private ratingsByBooking = new Map<string, Rating>();

  async createRequest(input: CreateResolutionRequestInput): Promise<ResolutionRequest> {
    const now = new Date().toISOString();
    const request: ResolutionRequest = {
      id: crypto.randomUUID(),
      doubtId: input.doubtId,
      resolverUserId: input.resolverUserId,
      durationMins: input.durationMins,
      amountCents: input.amountCents,
      proposedSlots: input.proposedSlots,
      status: "pending",
      acceptedSlotAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.requests.set(request.id, request);
    return request;
  }

  async getRequestById(id: string): Promise<ResolutionRequest | null> {
    return this.requests.get(id) ?? null;
  }

  async listRequests(filters: ResolutionRequestFilters): Promise<ResolutionRequest[]> {
    return Array.from(this.requests.values())
      .filter((r) => (filters.doubtId ? r.doubtId === filters.doubtId : true))
      .filter((r) => (filters.resolverUserId ? r.resolverUserId === filters.resolverUserId : true))
      .filter((r) => (filters.status ? r.status === filters.status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async acceptRequest(requestId: string, chosenSlot: string, bookingInput: CreateBookingInput): Promise<Booking> {
    const existing = this.requests.get(requestId);
    if (!existing) {
      throw new Error("resolution request not found");
    }

    // mirrors the DB partial unique index: only one accepted request per doubt
    const alreadyAccepted = Array.from(this.requests.values()).some(
      (r) => r.doubtId === existing.doubtId && r.status === "accepted",
    );
    if (alreadyAccepted) {
      throw new DuplicateAcceptedRequestError(existing.doubtId);
    }

    const now = new Date().toISOString();
    const updated: ResolutionRequest = {
      ...existing,
      status: "accepted",
      acceptedSlotAt: chosenSlot,
      updatedAt: now,
    };
    this.requests.set(requestId, updated);

    const booking: Booking = {
      id: crypto.randomUUID(),
      doubtId: bookingInput.doubtId,
      resolutionRequestId: bookingInput.resolutionRequestId,
      posterUserId: bookingInput.posterUserId,
      resolverUserId: bookingInput.resolverUserId,
      slotAt: bookingInput.slotAt,
      durationMins: bookingInput.durationMins,
      amountCents: bookingInput.amountCents,
      paymentId: null,
      providerRoomId: null,
      joinUrl: null,
      status: "scheduled",
      completedAt: null,
      createdAt: now,
    };
    this.bookings.set(booking.id, booking);
    return booking;
  }

  async rejectRequest(id: string): Promise<ResolutionRequest | null> {
    const existing = this.requests.get(id);
    if (!existing) return null;
    const updated: ResolutionRequest = { ...existing, status: "rejected", updatedAt: new Date().toISOString() };
    this.requests.set(id, updated);
    return updated;
  }

  async setBookingPaymentId(bookingId: string, paymentId: string): Promise<Booking | null> {
    const existing = this.bookings.get(bookingId);
    if (!existing) return null;
    const updated: Booking = { ...existing, paymentId };
    this.bookings.set(bookingId, updated);
    return updated;
  }

  async setBookingMeetingInfo(bookingId: string, providerRoomId: string, joinUrl: string): Promise<Booking | null> {
    const existing = this.bookings.get(bookingId);
    if (!existing) return null;
    const updated: Booking = { ...existing, providerRoomId, joinUrl };
    this.bookings.set(bookingId, updated);
    return updated;
  }

  async getBookingById(id: string): Promise<Booking | null> {
    return this.bookings.get(id) ?? null;
  }

  async listBookings(filters: BookingFilters): Promise<Booking[]> {
    return Array.from(this.bookings.values())
      .filter((b) => (filters.posterUserId ? b.posterUserId === filters.posterUserId : true))
      .filter((b) => (filters.resolverUserId ? b.resolverUserId === filters.resolverUserId : true))
      .filter((b) => (filters.status ? b.status === filters.status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async completeBooking(id: string): Promise<Booking | null> {
    const existing = this.bookings.get(id);
    if (!existing) return null;
    const updated: Booking = { ...existing, status: "completed", completedAt: new Date().toISOString() };
    this.bookings.set(id, updated);
    return updated;
  }

  async cancelBooking(id: string): Promise<Booking | null> {
    const existing = this.bookings.get(id);
    if (!existing) return null;
    const updated: Booking = { ...existing, status: "cancelled" };
    this.bookings.set(id, updated);
    return updated;
  }

  async createRating(input: CreateRatingInput): Promise<Rating> {
    if (this.ratingsByBooking.has(input.bookingId)) {
      throw new DuplicateRatingError(input.bookingId);
    }
    const rating: Rating = {
      id: crypto.randomUUID(),
      bookingId: input.bookingId,
      raterUserId: input.raterUserId,
      ratedUserId: input.ratedUserId,
      rating: input.rating,
      feedbackText: input.feedbackText,
      createdAt: new Date().toISOString(),
    };
    this.ratingsByBooking.set(input.bookingId, rating);
    return rating;
  }
}
