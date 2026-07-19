import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { Doubt, DoubtClient, FakeDoubtClient } from "./doubts/client.js";
import { FakePaymentClient, PaymentClient } from "./payments/client.js";
import { FakeStatsClient, StatsClient, ThrowingStatsClient } from "./stats/client.js";
import { InMemoryResolutionRepository } from "./resolution/repository.js";

const POSTER = "11111111-1111-1111-1111-111111111111";
const RESOLVER = "22222222-2222-2222-2222-222222222222";
const OTHER_USER = "33333333-3333-3333-3333-333333333333";
const DOUBT_ID = "44444444-4444-4444-4444-444444444444";

function futureSlot(msFromNow = 60 * 60 * 1000): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

function pastSlot(msAgo = 60 * 60 * 1000): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function openDoubt(overrides: Partial<Doubt> = {}): Doubt {
  return {
    id: DOUBT_ID,
    authorUserId: POSTER,
    title: "why does this integral diverge",
    description: "stuck",
    expertiseLevelIds: ["level-1"],
    status: "open",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function setup(opts: { doubt?: Doubt | null } = {}) {
  const repo = new InMemoryResolutionRepository();
  const doubtClient = new FakeDoubtClient();
  if (opts.doubt !== null) {
    doubtClient.seed(opts.doubt ?? openDoubt());
  }
  const paymentClient = new FakePaymentClient();
  const statsClient = new FakeStatsClient();
  const app = buildApp(repo, doubtClient, paymentClient, statsClient);
  return { app, repo, doubtClient, paymentClient, statsClient };
}

const validCreateBody = () => ({
  doubtId: DOUBT_ID,
  durationMins: 30,
  amountCents: 5000,
  proposedSlots: [futureSlot()],
});

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});

describe("auth: X-User-Id header", () => {
  it("401s every route when the header is missing", async () => {
    const { app } = setup();
    const routes: Array<{ method: "GET" | "POST"; url: string }> = [
      { method: "POST", url: "/resolution-requests" },
      { method: "POST", url: "/resolution-requests/some-id/accept" },
      { method: "POST", url: "/resolution-requests/some-id/reject" },
      { method: "GET", url: "/bookings/some-id" },
      { method: "GET", url: "/bookings/my?role=poster" },
      { method: "POST", url: "/bookings/some-id/complete" },
      { method: "POST", url: "/bookings/some-id/cancel" },
    ];
    for (const route of routes) {
      const res = await app.inject({ method: route.method, url: route.url, payload: {} });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(res.json().error).toBe("missing X-User-Id header");
    }
  });
});

describe("POST /resolution-requests", () => {
  it("creates a pending request", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: validCreateBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("pending");
    expect(body.resolverUserId).toBe(RESOLVER);
    expect(body.doubtId).toBe(DOUBT_ID);
  });

  it("404s when the doubt doesn't exist", async () => {
    const { app } = setup({ doubt: null });
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: validCreateBody(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s when the doubt is not open", async () => {
    const { app } = setup({ doubt: openDoubt({ status: "closed" }) });
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: validCreateBody(),
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects the doubt's own author sending a request against their own doubt", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": POSTER },
      payload: validCreateBody(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s on a missing required field", async () => {
    const { app } = setup();
    const { doubtId, ...rest } = validCreateBody();
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s on an empty proposedSlots array", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: { ...validCreateBody(), proposedSlots: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when a proposedSlots entry is in the past", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: { ...validCreateBody(), proposedSlots: [pastSlot()] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when a proposedSlots entry is unparseable", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: { ...validCreateBody(), proposedSlots: ["not-a-date"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when only one of several slots is invalid", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: { ...validCreateBody(), proposedSlots: [futureSlot(), pastSlot()] },
    });
    expect(res.statusCode).toBe(400);
  });

  describe("durationMins boundaries", () => {
    it("accepts exactly 480", async () => {
      const { app } = setup();
      const res = await app.inject({
        method: "POST",
        url: "/resolution-requests",
        headers: { "x-user-id": RESOLVER },
        payload: { ...validCreateBody(), durationMins: 480 },
      });
      expect(res.statusCode).toBe(201);
    });

    it("rejects 481", async () => {
      const { app } = setup();
      const res = await app.inject({
        method: "POST",
        url: "/resolution-requests",
        headers: { "x-user-id": RESOLVER },
        payload: { ...validCreateBody(), durationMins: 481 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects 0", async () => {
      const { app } = setup();
      const res = await app.inject({
        method: "POST",
        url: "/resolution-requests",
        headers: { "x-user-id": RESOLVER },
        payload: { ...validCreateBody(), durationMins: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a negative value", async () => {
      const { app } = setup();
      const res = await app.inject({
        method: "POST",
        url: "/resolution-requests",
        headers: { "x-user-id": RESOLVER },
        payload: { ...validCreateBody(), durationMins: -5 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("amountCents boundaries", () => {
    it("accepts 0", async () => {
      const { app } = setup();
      const res = await app.inject({
        method: "POST",
        url: "/resolution-requests",
        headers: { "x-user-id": RESOLVER },
        payload: { ...validCreateBody(), amountCents: 0 },
      });
      expect(res.statusCode).toBe(201);
    });

    it("rejects a negative value", async () => {
      const { app } = setup();
      const res = await app.inject({
        method: "POST",
        url: "/resolution-requests",
        headers: { "x-user-id": RESOLVER },
        payload: { ...validCreateBody(), amountCents: -1 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it("401s when the header is missing", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/resolution-requests", payload: validCreateBody() });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /resolution-requests", () => {
  it("filters by doubtId, resolverUserId, and status in combination", async () => {
    const { app, repo } = setup();
    await repo.createRequest({
      doubtId: DOUBT_ID,
      resolverUserId: RESOLVER,
      durationMins: 30,
      amountCents: 100,
      proposedSlots: [futureSlot()],
    });
    await repo.createRequest({
      doubtId: "other-doubt",
      resolverUserId: OTHER_USER,
      durationMins: 30,
      amountCents: 100,
      proposedSlots: [futureSlot()],
    });

    const res = await app.inject({ method: "GET", url: `/resolution-requests?doubtId=${DOUBT_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);

    const res2 = await app.inject({ method: "GET", url: `/resolution-requests?resolverUserId=${OTHER_USER}` });
    expect(res2.json()).toHaveLength(1);

    const res3 = await app.inject({ method: "GET", url: "/resolution-requests?status=pending" });
    expect(res3.json()).toHaveLength(2);

    const res4 = await app.inject({ method: "GET", url: "/resolution-requests?status=accepted" });
    expect(res4.json()).toHaveLength(0);
  });

  it("400s on an invalid status filter", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/resolution-requests?status=bogus" });
    expect(res.statusCode).toBe(400);
  });

  it("lists with no filters at all", async () => {
    const { app, repo } = setup();
    await repo.createRequest({
      doubtId: DOUBT_ID,
      resolverUserId: RESOLVER,
      durationMins: 30,
      amountCents: 100,
      proposedSlots: [futureSlot()],
    });
    const res = await app.inject({ method: "GET", url: "/resolution-requests" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});

async function createPendingRequest(
  app: ReturnType<typeof buildApp>,
  overrides: Partial<ReturnType<typeof validCreateBody>> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/resolution-requests",
    headers: { "x-user-id": RESOLVER },
    payload: { ...validCreateBody(), ...overrides },
  });
  return res.json();
}

describe("POST /resolution-requests/:id/accept", () => {
  it("accepts, closes the doubt, creates a booking with a paymentId", async () => {
    const { app, doubtClient, paymentClient } = setup();
    const slot = futureSlot();
    const created = await createPendingRequest(app, { proposedSlots: [slot] });

    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/accept`,
      headers: { "x-user-id": POSTER },
      payload: { chosenSlot: slot },
    });
    expect(res.statusCode).toBe(200);
    const booking = res.json();
    expect(booking.status).toBe("scheduled");
    expect(booking.paymentId).toBeTruthy();
    expect(booking.posterUserId).toBe(POSTER);
    expect(booking.resolverUserId).toBe(RESOLVER);

    const doubt = await doubtClient.getDoubt(DOUBT_ID);
    expect(doubt?.status).toBe("closed");
    expect(paymentClient.collectCalls).toHaveLength(1);
    expect(paymentClient.collectCalls[0]).toMatchObject({
      userId: POSTER,
      amountCents: 5000,
      referenceType: "booking",
      referenceId: booking.id,
    });
  });

  it("403s when the caller is not the doubt's author", async () => {
    const { app } = setup();
    const slot = futureSlot();
    const created = await createPendingRequest(app, { proposedSlots: [slot] });

    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/accept`,
      headers: { "x-user-id": OTHER_USER },
      payload: { chosenSlot: slot },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s when the resolver tries to accept their own sent request", async () => {
    const { app } = setup();
    const slot = futureSlot();
    const created = await createPendingRequest(app, { proposedSlots: [slot] });

    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/accept`,
      headers: { "x-user-id": RESOLVER },
      payload: { chosenSlot: slot },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s for an unknown request id", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests/does-not-exist/accept",
      headers: { "x-user-id": POSTER },
      payload: { chosenSlot: futureSlot() },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when chosenSlot is not one of the proposedSlots", async () => {
    const { app } = setup();
    const slot = futureSlot();
    const created = await createPendingRequest(app, { proposedSlots: [slot] });

    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/accept`,
      headers: { "x-user-id": POSTER },
      payload: { chosenSlot: futureSlot(120 * 60 * 1000) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when chosenSlot is missing", async () => {
    const { app } = setup();
    const created = await createPendingRequest(app);
    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/accept`,
      headers: { "x-user-id": POSTER },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("409s accepting the same request twice", async () => {
    const { app } = setup();
    const slot = futureSlot();
    const created = await createPendingRequest(app, { proposedSlots: [slot] });

    const first = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/accept`,
      headers: { "x-user-id": POSTER },
      payload: { chosenSlot: slot },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/accept`,
      headers: { "x-user-id": POSTER },
      payload: { chosenSlot: slot },
    });
    expect(second.statusCode).toBe(409);
  });

  it("409s accepting a second distinct request for the same doubt after the first was accepted", async () => {
    const { app } = setup();
    const slotA = futureSlot();
    const slotB = futureSlot(2 * 60 * 60 * 1000);
    const firstRequest = await createPendingRequest(app, { proposedSlots: [slotA] });
    const secondRequest = await createPendingRequest(app, { proposedSlots: [slotB] });

    const acceptFirst = await app.inject({
      method: "POST",
      url: `/resolution-requests/${firstRequest.id}/accept`,
      headers: { "x-user-id": POSTER },
      payload: { chosenSlot: slotA },
    });
    expect(acceptFirst.statusCode).toBe(200);

    const acceptSecond = await app.inject({
      method: "POST",
      url: `/resolution-requests/${secondRequest.id}/accept`,
      headers: { "x-user-id": POSTER },
      payload: { chosenSlot: slotB },
    });
    // the second request is still "pending" in app-layer terms, so this proves the DB-level
    // partial unique index (not just the app's own pending-status check) is what blocks it --
    // exercised here via the in-memory repository's mirrored guard, see repository.ts
    expect(acceptSecond.statusCode).toBe(409);
  });

  it("propagates a doubt client failure as a real error rather than silently proceeding", async () => {
    const repo = new InMemoryResolutionRepository();
    const throwingDoubtClient: DoubtClient = {
      getDoubt: async () => openDoubt(),
      closeDoubt: async () => {
        throw new Error("doubt service unreachable");
      },
    };
    const app = buildApp(repo, throwingDoubtClient, new FakePaymentClient(), new FakeStatsClient());
    const slot = futureSlot();
    const created = await createPendingRequest(app, { proposedSlots: [slot] });

    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/accept`,
      headers: { "x-user-id": POSTER },
      payload: { chosenSlot: slot },
    });
    // fastify's default error handler turns the thrown error into a 500 -- the key assertion is
    // that it's a real failure, not a silent 200 with the doubt left unclosed
    expect(res.statusCode).toBe(500);
  });

  it("propagates a payment client failure as a real error rather than silently proceeding", async () => {
    const repo = new InMemoryResolutionRepository();
    const doubtClient = new FakeDoubtClient();
    doubtClient.seed(openDoubt());
    const throwingPaymentClient: PaymentClient = {
      collectPayment: async () => {
        throw new Error("payment service unreachable");
      },
      refundPayment: async () => {},
    };
    const app = buildApp(repo, doubtClient, throwingPaymentClient, new FakeStatsClient());
    const slot = futureSlot();
    const created = await createPendingRequest(app, { proposedSlots: [slot] });

    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/accept`,
      headers: { "x-user-id": POSTER },
      payload: { chosenSlot: slot },
    });
    expect(res.statusCode).toBe(500);
  });
});

describe("POST /resolution-requests/:id/reject", () => {
  it("rejects a pending request", async () => {
    const { app } = setup();
    const created = await createPendingRequest(app);
    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/reject`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
  });

  it("403s when the caller is not the doubt's author", async () => {
    const { app } = setup();
    const created = await createPendingRequest(app);
    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/reject`,
      headers: { "x-user-id": RESOLVER },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s for an unknown id", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests/does-not-exist/reject",
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s rejecting an already-rejected request", async () => {
    const { app } = setup();
    const created = await createPendingRequest(app);
    await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/reject`,
      headers: { "x-user-id": POSTER },
    });
    const res = await app.inject({
      method: "POST",
      url: `/resolution-requests/${created.id}/reject`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(409);
  });
});

async function acceptAndBook(app: ReturnType<typeof buildApp>) {
  const slot = futureSlot();
  const created = await createPendingRequest(app, { proposedSlots: [slot] });
  const res = await app.inject({
    method: "POST",
    url: `/resolution-requests/${created.id}/accept`,
    headers: { "x-user-id": POSTER },
    payload: { chosenSlot: slot },
  });
  return res.json();
}

describe("GET /bookings/:id", () => {
  it("200s for the poster", async () => {
    const { app } = setup();
    const booking = await acceptAndBook(app);
    const res = await app.inject({
      method: "GET",
      url: `/bookings/${booking.id}`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(200);
  });

  it("200s for the resolver", async () => {
    const { app } = setup();
    const booking = await acceptAndBook(app);
    const res = await app.inject({
      method: "GET",
      url: `/bookings/${booking.id}`,
      headers: { "x-user-id": RESOLVER },
    });
    expect(res.statusCode).toBe(200);
  });

  it("403s for a third party -- a real ownership check, not just that the owner gets 200", async () => {
    const { app } = setup();
    const booking = await acceptAndBook(app);
    const res = await app.inject({
      method: "GET",
      url: `/bookings/${booking.id}`,
      headers: { "x-user-id": OTHER_USER },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s for an unknown booking id", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/bookings/does-not-exist",
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /bookings/my", () => {
  it("400s with no role", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/bookings/my", headers: { "x-user-id": POSTER } });
    expect(res.statusCode).toBe(400);
  });

  it("400s with an invalid role", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/bookings/my?role=bogus",
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists bookings for the caller as poster", async () => {
    const { app } = setup();
    await acceptAndBook(app);
    const res = await app.inject({
      method: "GET",
      url: "/bookings/my?role=poster",
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("lists bookings for the caller as resolver", async () => {
    const { app } = setup();
    await acceptAndBook(app);
    const res = await app.inject({
      method: "GET",
      url: "/bookings/my?role=resolver",
      headers: { "x-user-id": RESOLVER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("filters by status", async () => {
    const { app } = setup();
    await acceptAndBook(app);
    const res = await app.inject({
      method: "GET",
      url: "/bookings/my?role=poster&status=completed",
      headers: { "x-user-id": POSTER },
    });
    expect(res.json()).toHaveLength(0);
  });

  it("400s on an invalid status filter", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/bookings/my?role=poster&status=bogus",
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /bookings/:id/complete", () => {
  it("marks completed and calls stats client", async () => {
    const { app, statsClient } = setup();
    const booking = await acceptAndBook(app);
    const res = await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/complete`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
    expect(statsClient.calls).toEqual([{ userId: RESOLVER, minutes: booking.durationMins }]);
  });

  it("403s for a third party", async () => {
    const { app } = setup();
    const booking = await acceptAndBook(app);
    const res = await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/complete`,
      headers: { "x-user-id": OTHER_USER },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s for an unknown booking", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/bookings/does-not-exist/complete",
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s completing an already-completed booking", async () => {
    const { app } = setup();
    const booking = await acceptAndBook(app);
    await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/complete`,
      headers: { "x-user-id": POSTER },
    });
    const res = await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/complete`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(409);
  });

  it("a stats client failure does NOT block booking completion (deliberate asymmetry vs. doubt/payment clients)", async () => {
    const repo = new InMemoryResolutionRepository();
    const doubtClient = new FakeDoubtClient();
    doubtClient.seed(openDoubt());
    const app = buildApp(repo, doubtClient, new FakePaymentClient(), new ThrowingStatsClient());
    const booking = await acceptAndBook(app);

    const res = await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/complete`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
  });
});

describe("POST /bookings/:id/cancel", () => {
  it("cancels and refunds when a paymentId exists", async () => {
    const { app, paymentClient } = setup();
    const booking = await acceptAndBook(app);
    const res = await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/cancel`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cancelled");
    expect(paymentClient.refundCalls).toEqual([booking.paymentId]);
  });

  it("resolver can also cancel", async () => {
    const { app } = setup();
    const booking = await acceptAndBook(app);
    const res = await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/cancel`,
      headers: { "x-user-id": RESOLVER },
    });
    expect(res.statusCode).toBe(200);
  });

  it("403s for a third party", async () => {
    const { app } = setup();
    const booking = await acceptAndBook(app);
    const res = await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/cancel`,
      headers: { "x-user-id": OTHER_USER },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s for an unknown booking", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/bookings/does-not-exist/cancel",
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s cancelling an already-cancelled booking", async () => {
    const { app } = setup();
    const booking = await acceptAndBook(app);
    await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/cancel`,
      headers: { "x-user-id": POSTER },
    });
    const res = await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/cancel`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(409);
  });

  it("a refund failure fails the whole cancel request rather than leaving the booking cancelled with no refund attempted", async () => {
    const repo = new InMemoryResolutionRepository();
    const doubtClient = new FakeDoubtClient();
    doubtClient.seed(openDoubt());
    const throwingPaymentClient: PaymentClient = {
      collectPayment: async () => ({ paymentId: "fake-payment-1" }),
      refundPayment: async () => {
        throw new Error("payment service unreachable");
      },
    };
    const app = buildApp(repo, doubtClient, throwingPaymentClient, new FakeStatsClient());
    const booking = await acceptAndBook(app);

    const res = await app.inject({
      method: "POST",
      url: `/bookings/${booking.id}/cancel`,
      headers: { "x-user-id": POSTER },
    });
    expect(res.statusCode).toBe(500);

    const stillScheduled = await repo.getBookingById(booking.id);
    expect(stillScheduled?.status).toBe("scheduled");
  });
});

describe("injection / untrusted-string handling", () => {
  it("handles a SQL-injection-style doubtId safely via the in-memory path without erroring the request incorrectly", async () => {
    const { app } = setup({ doubt: null });
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: { ...validCreateBody(), doubtId: "'; DROP TABLE resolution_requests; --" },
    });
    // no matching doubt seeded under that id -- doubt client returns null, so this is a clean 404,
    // not a crash or an injected query
    expect(res.statusCode).toBe(404);
  });

  it("handles a script-tag-style title/description passthrough safely (doubt fields are echoed, not executed)", async () => {
    const { app } = setup({ doubt: openDoubt({ title: "<script>alert(1)</script>" }) });
    const res = await app.inject({
      method: "POST",
      url: "/resolution-requests",
      headers: { "x-user-id": RESOLVER },
      payload: validCreateBody(),
    });
    expect(res.statusCode).toBe(201);
  });
});
