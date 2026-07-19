import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import { DoubtClient, FakeDoubtClient } from "./doubts/client.js";
import { FakePaymentClient, PaymentClient } from "./payments/client.js";
import { FakeStatsClient, StatsClient } from "./stats/client.js";
import {
  Booking,
  BookingFilters,
  BookingStatus,
  DuplicateAcceptedRequestError,
  InMemoryResolutionRepository,
  ResolutionRepository,
  ResolutionRequestFilters,
  ResolutionRequestStatus,
} from "./resolution/repository.js";

const MAX_DURATION_MINS = 480;

interface CreateRequestBody {
  doubtId?: string;
  durationMins?: number;
  amountCents?: number;
  proposedSlots?: string[];
}

interface AcceptRequestBody {
  chosenSlot?: string;
}

interface ListRequestsQuery {
  doubtId?: string;
  resolverUserId?: string;
  status?: string;
}

interface ListBookingsQuery {
  role?: string;
  status?: string;
}

const VALID_REQUEST_STATUSES: ResolutionRequestStatus[] = ["pending", "accepted", "rejected"];
const VALID_BOOKING_STATUSES: BookingStatus[] = ["scheduled", "completed", "cancelled"];

export function buildApp(
  resolutionRepository: ResolutionRepository = new InMemoryResolutionRepository(),
  doubtClient: DoubtClient = new FakeDoubtClient(),
  paymentClient: PaymentClient = new FakePaymentClient(),
  statsClient: StatsClient = new FakeStatsClient(),
): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });

  // Fastify's default JSON parser rejects an empty body when Content-Type: application/json is
  // set, even for methods like DELETE/POST-with-no-body (accept, reject, complete, cancel all
  // legitimately have none) -- our own frontend sends that header unconditionally on every
  // request, so this bites any no-body call otherwise. Confirmed live: a real POST .../reject
  // with an empty body and Content-Type: application/json failed with FST_ERR_CTP_EMPTY_JSON_BODY
  // before this fix.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // the gateway verifies the caller's JWT and injects this header -- this service never verifies
  // a token itself, per ARCHITECTURE_DECISIONS.md's gateway-trust decision. still defends against
  // a missing header (e.g. a stray direct call bypassing the gateway) rather than assuming it.
  function requireUserId(request: FastifyRequest): string | null {
    const userId = request.headers["x-user-id"];
    if (!userId || Array.isArray(userId)) return null;
    return userId;
  }

  function validateSlots(slots: unknown): string[] | null {
    if (!Array.isArray(slots) || slots.length === 0) return null;
    const now = Date.now();
    for (const slot of slots) {
      if (typeof slot !== "string") return null;
      const parsed = new Date(slot).getTime();
      if (Number.isNaN(parsed) || parsed <= now) return null;
    }
    return slots;
  }

  app.post<{ Body: CreateRequestBody }>("/resolution-requests", async (request, reply) => {
    const callerUserId = requireUserId(request);
    if (!callerUserId) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }

    const { doubtId, durationMins, amountCents, proposedSlots } = request.body ?? {};
    if (!doubtId || durationMins === undefined || amountCents === undefined || proposedSlots === undefined) {
      return reply.code(400).send({ error: "doubtId, durationMins, amountCents and proposedSlots are required" });
    }

    if (!Number.isInteger(durationMins) || durationMins <= 0 || durationMins > MAX_DURATION_MINS) {
      return reply.code(400).send({ error: `durationMins must be an integer between 1 and ${MAX_DURATION_MINS}` });
    }

    if (!Number.isInteger(amountCents) || amountCents < 0) {
      return reply.code(400).send({ error: "amountCents must be a non-negative integer" });
    }

    const validSlots = validateSlots(proposedSlots);
    if (!validSlots) {
      return reply.code(400).send({ error: "proposedSlots must be a non-empty array of future ISO timestamps" });
    }

    const doubt = await doubtClient.getDoubt(doubtId);
    if (!doubt) {
      return reply.code(404).send({ error: "doubt not found" });
    }

    if (doubt.status !== "open") {
      return reply.code(409).send({ error: `doubt is ${doubt.status}, not open` });
    }

    if (doubt.authorUserId === callerUserId) {
      return reply.code(400).send({ error: "cannot send a resolution request for your own doubt" });
    }

    const created = await resolutionRepository.createRequest({
      doubtId,
      resolverUserId: callerUserId,
      durationMins,
      amountCents,
      proposedSlots: validSlots,
    });
    request.log.info({ requestId: created.id, doubtId }, "resolution request created");
    return reply.code(201).send(created);
  });

  app.get<{ Querystring: ListRequestsQuery }>("/resolution-requests", async (request, reply) => {
    const { doubtId, resolverUserId, status } = request.query;
    if (status !== undefined && !VALID_REQUEST_STATUSES.includes(status as ResolutionRequestStatus)) {
      return reply.code(400).send({ error: "status must be one of 'pending', 'accepted', 'rejected'" });
    }

    const filters: ResolutionRequestFilters = {};
    if (doubtId) filters.doubtId = doubtId;
    if (resolverUserId) filters.resolverUserId = resolverUserId;
    if (status) filters.status = status as ResolutionRequestStatus;

    const requests = await resolutionRepository.listRequests(filters);
    return reply.send(requests);
  });

  app.post<{ Params: { id: string }; Body: AcceptRequestBody }>(
    "/resolution-requests/:id/accept",
    async (request, reply) => {
      const callerUserId = requireUserId(request);
      if (!callerUserId) {
        return reply.code(401).send({ error: "missing X-User-Id header" });
      }

      const { chosenSlot } = request.body ?? {};
      if (!chosenSlot) {
        return reply.code(400).send({ error: "chosenSlot is required" });
      }

      const resolutionRequest = await resolutionRepository.getRequestById(request.params.id);
      if (!resolutionRequest) {
        return reply.code(404).send({ error: "resolution request not found" });
      }

      const doubt = await doubtClient.getDoubt(resolutionRequest.doubtId);
      if (!doubt) {
        return reply.code(404).send({ error: "doubt not found" });
      }

      // only the doubt's original author may accept a request sent against it
      if (doubt.authorUserId !== callerUserId) {
        return reply.code(403).send({ error: "only the doubt's author can accept this request" });
      }

      if (resolutionRequest.status !== "pending") {
        return reply.code(409).send({ error: `resolution request is already ${resolutionRequest.status}` });
      }

      if (!resolutionRequest.proposedSlots.includes(chosenSlot)) {
        return reply.code(400).send({ error: "chosenSlot must be one of the request's proposedSlots" });
      }

      let booking: Booking;
      try {
        booking = await resolutionRepository.acceptRequest(resolutionRequest.id, chosenSlot, {
          doubtId: resolutionRequest.doubtId,
          resolutionRequestId: resolutionRequest.id,
          posterUserId: callerUserId,
          resolverUserId: resolutionRequest.resolverUserId,
          slotAt: chosenSlot,
          durationMins: resolutionRequest.durationMins,
          amountCents: resolutionRequest.amountCents,
        });
      } catch (err) {
        // relies on the DB's partial unique index to actually catch this race -- app-layer
        // check-then-accept alone can't close the gap between two concurrent accepts
        if (err instanceof DuplicateAcceptedRequestError) {
          return reply.code(409).send({ error: "doubt already has an accepted resolution request" });
        }
        throw err;
      }

      await doubtClient.closeDoubt(resolutionRequest.doubtId);

      // payment happens after the DB transaction commits -- a payment failure here means the
      // booking exists but unpaid, which the caller must see as a real error, not silently ignore
      const { paymentId } = await paymentClient.collectPayment({
        userId: callerUserId,
        amountCents: resolutionRequest.amountCents,
        type: "resolution",
        referenceType: "booking",
        referenceId: booking.id,
        recipientUserId: booking.resolverUserId,
      });
      const withPayment = await resolutionRepository.setBookingPaymentId(booking.id, paymentId);

      request.log.info({ bookingId: booking.id, requestId: resolutionRequest.id }, "resolution request accepted");
      return reply.send(withPayment ?? { ...booking, paymentId });
    },
  );

  app.post<{ Params: { id: string } }>("/resolution-requests/:id/reject", async (request, reply) => {
    const callerUserId = requireUserId(request);
    if (!callerUserId) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }

    const resolutionRequest = await resolutionRepository.getRequestById(request.params.id);
    if (!resolutionRequest) {
      return reply.code(404).send({ error: "resolution request not found" });
    }

    const doubt = await doubtClient.getDoubt(resolutionRequest.doubtId);
    if (!doubt) {
      return reply.code(404).send({ error: "doubt not found" });
    }

    if (doubt.authorUserId !== callerUserId) {
      return reply.code(403).send({ error: "only the doubt's author can reject this request" });
    }

    if (resolutionRequest.status !== "pending") {
      return reply.code(409).send({ error: `resolution request is already ${resolutionRequest.status}` });
    }

    const updated = await resolutionRepository.rejectRequest(resolutionRequest.id);
    request.log.info({ requestId: resolutionRequest.id }, "resolution request rejected");
    return reply.send(updated);
  });

  app.get<{ Params: { id: string } }>("/bookings/:id", async (request, reply) => {
    const callerUserId = requireUserId(request);
    if (!callerUserId) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }

    const booking = await resolutionRepository.getBookingById(request.params.id);
    if (!booking) {
      return reply.code(404).send({ error: "booking not found" });
    }

    if (booking.posterUserId !== callerUserId && booking.resolverUserId !== callerUserId) {
      return reply.code(403).send({ error: "not authorized to view this booking" });
    }

    return reply.send(booking);
  });

  app.get<{ Querystring: ListBookingsQuery }>("/bookings/my", async (request, reply) => {
    const callerUserId = requireUserId(request);
    if (!callerUserId) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }

    const { role, status } = request.query;
    if (role !== "poster" && role !== "resolver") {
      return reply.code(400).send({ error: "role must be 'poster' or 'resolver'" });
    }

    if (status !== undefined && !VALID_BOOKING_STATUSES.includes(status as BookingStatus)) {
      return reply.code(400).send({ error: "status must be one of 'scheduled', 'completed', 'cancelled'" });
    }

    const filters: BookingFilters = role === "poster" ? { posterUserId: callerUserId } : { resolverUserId: callerUserId };
    if (status) filters.status = status as BookingStatus;

    const bookings = await resolutionRepository.listBookings(filters);
    return reply.send(bookings);
  });

  app.post<{ Params: { id: string } }>("/bookings/:id/complete", async (request, reply) => {
    const callerUserId = requireUserId(request);
    if (!callerUserId) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }

    const booking = await resolutionRepository.getBookingById(request.params.id);
    if (!booking) {
      return reply.code(404).send({ error: "booking not found" });
    }

    if (booking.posterUserId !== callerUserId && booking.resolverUserId !== callerUserId) {
      return reply.code(403).send({ error: "not authorized to complete this booking" });
    }

    if (booking.status !== "scheduled") {
      return reply.code(409).send({ error: `booking is already ${booking.status}` });
    }

    const updated = await resolutionRepository.completeBooking(booking.id);

    // stats update degrades gracefully -- see stats/client.ts's comment. never let this block
    // or fail the completion itself.
    try {
      await statsClient.incrementMinutesResolved(booking.resolverUserId, booking.durationMins);
    } catch (err) {
      request.log.warn({ bookingId: booking.id, err }, "stats update failed, booking still completed");
    }

    request.log.info({ bookingId: booking.id }, "booking completed");
    return reply.send(updated);
  });

  app.post<{ Params: { id: string } }>("/bookings/:id/cancel", async (request, reply) => {
    const callerUserId = requireUserId(request);
    if (!callerUserId) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }

    const booking = await resolutionRepository.getBookingById(request.params.id);
    if (!booking) {
      return reply.code(404).send({ error: "booking not found" });
    }

    if (booking.posterUserId !== callerUserId && booking.resolverUserId !== callerUserId) {
      return reply.code(403).send({ error: "not authorized to cancel this booking" });
    }

    if (booking.status !== "scheduled") {
      return reply.code(409).send({ error: `booking is already ${booking.status}` });
    }

    // refund must not silently fail -- if it throws, the whole cancel request fails so it can
    // be retried, rather than leaving the booking cancelled with no refund attempted
    if (booking.paymentId) {
      await paymentClient.refundPayment(booking.paymentId);
    }

    const updated = await resolutionRepository.cancelBooking(booking.id);
    request.log.info({ bookingId: booking.id }, "booking cancelled");
    return reply.send(updated);
  });

  return app;
}
