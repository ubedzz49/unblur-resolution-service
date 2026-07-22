import { logger } from "../logger.js";

export interface CreateRoomInput {
  referenceId: string;
  durationMins: number;
}

export interface RoomInfo {
  providerRoomId: string;
  joinUrl: string;
  expiresAt: string;
}

export interface MeetingClient {
  createRoom(input: CreateRoomInput): Promise<RoomInfo>;
  endRoom(providerRoomId: string): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 2000;

// createRoom follows the same "no silent fallback" rule as PaymentClient/DoubtClient -- a
// booking with no real meeting room is a real problem, so a failure here throws and the accept
// flow fails outright. endRoom is the opposite: meeting-service is designed to degrade
// gracefully server-side even if the underlying provider call fails, so a caller-side failure
// (network blip, timeout) is just noise here too -- log a warning, never block completion.
export class HttpMeetingClient implements MeetingClient {
  private baseUrl: string;
  private internalToken: string;

  constructor(baseUrl = process.env.MEETING_SERVICE_URL ?? "", internalToken = process.env.INTERNAL_SERVICE_TOKEN ?? "") {
    this.baseUrl = baseUrl;
    this.internalToken = internalToken;
  }

  async createRoom(input: CreateRoomInput): Promise<RoomInfo> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/rooms", this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Service-Token": this.internalToken,
        },
        body: JSON.stringify({ type: "resolution", referenceId: input.referenceId, durationMins: input.durationMins }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`meeting service returned ${res.status} creating room`);
      }
      return (await res.json()) as RoomInfo;
    } finally {
      clearTimeout(timeout);
    }
  }

  async endRoom(providerRoomId: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`/internal/rooms/${providerRoomId}/end`, this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Service-Token": this.internalToken,
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ providerRoomId, status: res.status }, "meeting service returned non-ok ending room, ignoring");
      }
    } catch (err) {
      logger.warn({ providerRoomId, err }, "meeting service call failed or timed out ending room, ignoring");
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeMeetingClient implements MeetingClient {
  public createCalls: CreateRoomInput[] = [];
  public endCalls: string[] = [];
  private nextRoomId = 1;

  async createRoom(input: CreateRoomInput): Promise<RoomInfo> {
    this.createCalls.push(input);
    const id = `fake-room-${this.nextRoomId++}`;
    return {
      providerRoomId: id,
      joinUrl: `https://meet.fake/${id}`,
      expiresAt: new Date(Date.now() + input.durationMins * 60 * 1000).toISOString(),
    };
  }

  async endRoom(providerRoomId: string): Promise<void> {
    this.endCalls.push(providerRoomId);
  }
}

// test-only -- simulates room creation failing, to prove accept fails cleanly rather than
// silently proceeding without a joinUrl
export class ThrowingCreateMeetingClient implements MeetingClient {
  async createRoom(): Promise<RoomInfo> {
    throw new Error("meeting service unreachable");
  }

  async endRoom(): Promise<void> {}
}

// test-only -- simulates endRoom failing, to prove completion isn't blocked by it
export class ThrowingEndMeetingClient implements MeetingClient {
  public createCalls: CreateRoomInput[] = [];
  private nextRoomId = 1;

  async createRoom(input: CreateRoomInput): Promise<RoomInfo> {
    this.createCalls.push(input);
    const id = `fake-room-${this.nextRoomId++}`;
    return { providerRoomId: id, joinUrl: `https://meet.fake/${id}`, expiresAt: new Date().toISOString() };
  }

  async endRoom(): Promise<void> {
    throw new Error("meeting service unreachable");
  }
}
