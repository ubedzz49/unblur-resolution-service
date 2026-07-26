import { logger } from "../logger.js";

export interface AiNotesClient {
  // kicks off note generation for a completed session -- fire-and-forget from the caller's side,
  // AI Notes Service owns its own retry/backoff if the pipeline fails downstream. providerRoomId
  // lets it fetch the Daily transcript for this session; omitted if the booking never got a room
  // (e.g. meeting-service call failed at accept time).
  trigger(referenceType: string, referenceId: string, participantUserIds: string[], providerRoomId?: string): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 2000;

// same graceful-degrade rule as HttpNotificationClient -- notes are a nice-to-have follow-up, not
// a reason to fail or delay the booking completion that already happened. Always logs and
// swallows, never throws.
export class HttpAiNotesClient implements AiNotesClient {
  private baseUrl: string;
  private internalToken: string;

  constructor(baseUrl = process.env.AI_NOTES_SERVICE_URL ?? "", internalToken = process.env.INTERNAL_SERVICE_TOKEN ?? "") {
    this.baseUrl = baseUrl;
    this.internalToken = internalToken;
  }

  async trigger(referenceType: string, referenceId: string, participantUserIds: string[], providerRoomId?: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/ai-notes/trigger", this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Service-Token": this.internalToken,
        },
        body: JSON.stringify({ referenceType, referenceId, participantUserIds, providerRoomId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ referenceType, referenceId, status: res.status }, "ai notes service returned non-ok triggering notes, ignoring");
      }
    } catch (err) {
      logger.warn({ referenceType, referenceId, err }, "ai notes service call failed or timed out triggering notes, ignoring");
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeAiNotesClient implements AiNotesClient {
  public calls: { referenceType: string; referenceId: string; participantUserIds: string[]; providerRoomId?: string }[] = [];

  async trigger(referenceType: string, referenceId: string, participantUserIds: string[], providerRoomId?: string): Promise<void> {
    this.calls.push({ referenceType, referenceId, participantUserIds, providerRoomId });
  }
}

// test-only -- simulates the failure path to prove the completion handler degrades gracefully
export class ThrowingAiNotesClient implements AiNotesClient {
  async trigger(): Promise<void> {
    throw new Error("ai notes service unreachable");
  }
}
