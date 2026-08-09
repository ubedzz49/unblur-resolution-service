export interface PublicUserSummary {
  id: string;
  name: string;
}

export interface UserClient {
  // used to enrich notification copy ("X wants to resolve your doubt") -- never blocks the
  // calling flow if it fails, callers are expected to fall back to a generic message
  getUsersByIds(userIds: string[]): Promise<PublicUserSummary[]>;
}

const REQUEST_TIMEOUT_MS = 2000;

export class HttpUserClient implements UserClient {
  constructor(
    private readonly baseUrl: string = process.env.USER_SERVICE_URL ?? "",
    private readonly internalToken: string = process.env.INTERNAL_SERVICE_TOKEN ?? "",
  ) {}

  async getUsersByIds(userIds: string[]): Promise<PublicUserSummary[]> {
    if (userIds.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/users/bulk", this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Internal-Service-Token": this.internalToken },
        body: JSON.stringify({ userIds }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`user service returned ${res.status} fetching bulk users`);
      const body = (await res.json()) as { users: { id: string; name: string }[] };
      return body.users.map((u) => ({ id: u.id, name: u.name }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeUserClient implements UserClient {
  public usersById = new Map<string, PublicUserSummary>();

  async getUsersByIds(userIds: string[]): Promise<PublicUserSummary[]> {
    return userIds.map((id) => this.usersById.get(id)).filter((u): u is PublicUserSummary => Boolean(u));
  }
}
