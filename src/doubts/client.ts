export type DoubtStatus = "open" | "resolved" | "closed";

export interface Doubt {
  id: string;
  authorUserId: string;
  title: string;
  description: string | null;
  expertiseLevelIds: string[];
  status: DoubtStatus;
  createdAt: string;
}

export interface DoubtClient {
  getDoubt(id: string): Promise<Doubt | null>;
  closeDoubt(id: string): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 2000;

// unlike the feed's related-expertise expansion, this cannot degrade to "skip it" -- a
// resolution request or booking without a real underlying doubt is meaningless, so every
// failure here throws and the caller returns a real error rather than proceeding silently
export class HttpDoubtClient implements DoubtClient {
  private baseUrl: string;

  constructor(baseUrl = process.env.DOUBT_SERVICE_URL ?? "") {
    this.baseUrl = baseUrl;
  }

  async getDoubt(id: string): Promise<Doubt | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`/doubts/${id}`, this.baseUrl);
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`doubt service returned ${res.status}`);
      }
      return (await res.json()) as Doubt;
    } finally {
      clearTimeout(timeout);
    }
  }

  async closeDoubt(id: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`/doubts/${id}/status`, this.baseUrl);
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "closed" }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`doubt service returned ${res.status} closing doubt`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeDoubtClient implements DoubtClient {
  constructor(private doubts = new Map<string, Doubt>()) {}

  seed(doubt: Doubt): void {
    this.doubts.set(doubt.id, doubt);
  }

  async getDoubt(id: string): Promise<Doubt | null> {
    return this.doubts.get(id) ?? null;
  }

  async closeDoubt(id: string): Promise<void> {
    const existing = this.doubts.get(id);
    if (existing) {
      this.doubts.set(id, { ...existing, status: "closed" });
    }
  }
}
