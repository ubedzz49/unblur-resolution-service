export interface CollectPaymentInput {
  userId: string;
  amountCents: number;
  type: "resolution";
  referenceType: "booking";
  referenceId: string;
}

export interface PaymentClient {
  collectPayment(input: CollectPaymentInput): Promise<{ paymentId: string }>;
  refundPayment(paymentId: string): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 2000;

// same "no silent fallback" rule as HttpDoubtClient -- a booking without a real payment record,
// or a cancel that silently fails to refund, is a real money problem. every failure here throws.
export class HttpPaymentClient implements PaymentClient {
  private baseUrl: string;
  private internalToken: string;

  constructor(baseUrl = process.env.PAYMENT_SERVICE_URL ?? "", internalToken = process.env.INTERNAL_SERVICE_TOKEN ?? "") {
    this.baseUrl = baseUrl;
    this.internalToken = internalToken;
  }

  async collectPayment(input: CollectPaymentInput): Promise<{ paymentId: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/payments/collect", this.baseUrl);
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
        throw new Error(`payment service returned ${res.status} collecting payment`);
      }
      return (await res.json()) as { paymentId: string };
    } finally {
      clearTimeout(timeout);
    }
  }

  async refundPayment(paymentId: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`/internal/payments/${paymentId}/refund`, this.baseUrl);
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
        throw new Error(`payment service returned ${res.status} refunding payment`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakePaymentClient implements PaymentClient {
  public collectCalls: CollectPaymentInput[] = [];
  public refundCalls: string[] = [];
  private nextPaymentId = 1;

  async collectPayment(input: CollectPaymentInput): Promise<{ paymentId: string }> {
    this.collectCalls.push(input);
    return { paymentId: `fake-payment-${this.nextPaymentId++}` };
  }

  async refundPayment(paymentId: string): Promise<void> {
    this.refundCalls.push(paymentId);
  }
}
