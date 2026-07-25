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
  // mints a resolver-specific join link so Daily can attribute their session to a user id, for
  // the attendance check below. Degrades gracefully on failure (falls back to the plain joinUrl)
  // -- worst case the resolver's attendance reads as 0 and the payout is withheld, never released
  // on an unverified number.
  mintJoinToken(providerRoomId: string, joinUrl: string, userId: string, expiresAt: string): Promise<string>;
  // sums the given user's real time in the room, in seconds
  getAttendedSeconds(providerRoomId: string, userId: string): Promise<number>;
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

  async mintJoinToken(providerRoomId: string, joinUrl: string, userId: string, expiresAt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`/internal/rooms/${providerRoomId}/tokens`, this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Service-Token": this.internalToken,
        },
        body: JSON.stringify({ userId, joinUrl, expiresAt }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`meeting service returned ${res.status} minting join token`);
      }
      const body = (await res.json()) as { joinUrl: string };
      return body.joinUrl;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAttendedSeconds(providerRoomId: string, userId: string): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`/internal/rooms/${providerRoomId}/attendance`, this.baseUrl);
      url.searchParams.set("userId", userId);
      const res = await fetch(url, {
        headers: { "X-Internal-Service-Token": this.internalToken },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`meeting service returned ${res.status} fetching attendance`);
      }
      const body = (await res.json()) as { attendedSeconds: number };
      return body.attendedSeconds;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeMeetingClient implements MeetingClient {
  public createCalls: CreateRoomInput[] = [];
  public endCalls: string[] = [];
  public mintTokenCalls: { providerRoomId: string; userId: string }[] = [];
  // test seam: set the attendance a given room should report, keyed by providerRoomId. Defaults
  // to 0 (no attendance recorded), matching Meeting Service's own fail-safe default.
  public attendedSecondsByRoom = new Map<string, number>();
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

  async mintJoinToken(providerRoomId: string, joinUrl: string, userId: string): Promise<string> {
    this.mintTokenCalls.push({ providerRoomId, userId });
    return `${joinUrl}?t=fake-token-${userId}`;
  }

  async getAttendedSeconds(providerRoomId: string): Promise<number> {
    return this.attendedSecondsByRoom.get(providerRoomId) ?? 0;
  }
}

// test-only -- simulates room creation failing, to prove accept fails cleanly rather than
// silently proceeding without a joinUrl
export class ThrowingCreateMeetingClient implements MeetingClient {
  async createRoom(): Promise<RoomInfo> {
    throw new Error("meeting service unreachable");
  }

  async endRoom(): Promise<void> {}

  async mintJoinToken(_providerRoomId: string, joinUrl: string): Promise<string> {
    return joinUrl;
  }

  async getAttendedSeconds(): Promise<number> {
    return 0;
  }
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

  async mintJoinToken(_providerRoomId: string, joinUrl: string): Promise<string> {
    return joinUrl;
  }

  async getAttendedSeconds(): Promise<number> {
    return 0;
  }
}
