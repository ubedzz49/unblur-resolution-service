import { logger } from "../logger.js";

export interface StatsClient {
  incrementMinutesResolved(userId: string, minutes: number): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 2000;

// deliberate asymmetry vs. DoubtClient/PaymentClient: those throw on failure because a booking
// without a real doubt or payment is a real problem, but a stats-update hiccup shouldn't block
// the booking from completing -- the booking completing is what actually matters here, so this
// degrades to a logged warning instead
export class HttpStatsClient implements StatsClient {
  private baseUrl: string;
  private internalToken: string;

  constructor(baseUrl = process.env.USER_SERVICE_URL ?? "", internalToken = process.env.INTERNAL_SERVICE_TOKEN ?? "") {
    this.baseUrl = baseUrl;
    this.internalToken = internalToken;
  }

  async incrementMinutesResolved(userId: string, minutes: number): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`/internal/users/${userId}/stats/increment-minutes-resolved`, this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Service-Token": this.internalToken,
        },
        body: JSON.stringify({ minutes }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ userId, status: res.status }, "user service returned non-ok incrementing minutes resolved, ignoring");
      }
    } catch (err) {
      logger.warn({ userId, err }, "user service call failed or timed out incrementing minutes resolved, ignoring");
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeStatsClient implements StatsClient {
  public calls: Array<{ userId: string; minutes: number }> = [];

  async incrementMinutesResolved(userId: string, minutes: number): Promise<void> {
    this.calls.push({ userId, minutes });
  }
}

// test-only -- simulates the failure path to prove completion isn't blocked by it
export class ThrowingStatsClient implements StatsClient {
  async incrementMinutesResolved(): Promise<void> {
    throw new Error("stats service unreachable");
  }
}
