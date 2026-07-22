import { logger } from "../logger.js";

export interface NotifyInput {
  userId: string;
  type: string;
  referenceType: string;
  referenceId: string;
  title: string;
  body?: string;
}

export interface NotificationClient {
  notify(input: NotifyInput): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 2000;

// every call site treats a failed notification the same way -- it's never a reason to fail the
// real user-facing action, so this always degrades to a logged warning, never throws
export class HttpNotificationClient implements NotificationClient {
  private baseUrl: string;
  private internalToken: string;

  constructor(
    baseUrl = process.env.NOTIFICATION_SERVICE_URL ?? "",
    internalToken = process.env.INTERNAL_SERVICE_TOKEN ?? "",
  ) {
    this.baseUrl = baseUrl;
    this.internalToken = internalToken;
  }

  async notify(input: NotifyInput): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/notifications", this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Service-Token": this.internalToken,
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ userId: input.userId, type: input.type, status: res.status }, "notification service returned non-ok, ignoring");
      }
    } catch (err) {
      logger.warn({ userId: input.userId, type: input.type, err }, "notification service call failed or timed out, ignoring");
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeNotificationClient implements NotificationClient {
  public calls: NotifyInput[] = [];

  async notify(input: NotifyInput): Promise<void> {
    this.calls.push(input);
  }
}

// test-only -- simulates the failure path to prove every call site degrades gracefully
export class ThrowingNotificationClient implements NotificationClient {
  async notify(): Promise<void> {
    throw new Error("notification service unreachable");
  }
}
