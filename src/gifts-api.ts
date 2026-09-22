/** Invoice issued by 21.gifts api. */
export interface IssuedInvoice {
  id: string;
  pr: string;
  paymentHash: string;
  amountMsat: number;
}

/** HTTP error from 21.gifts. */
export class GiftsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GiftsApiError';
    this.status = status;
  }
}

const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Client for `GET /invoices/passkey`, `GET /invoices/posted`, `GET /invoices/eligible`,
 * `POST /invoices`, and `POST /invoices/proof`.
 */
export class GiftsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Whether 21.gifts reports a passkey for this Lightning Address.
   *
   * @param address - LUD-16 address.
   * @returns `true` when the address has a passkey.
   */
  async hasPasskey(address: string): Promise<boolean> {
    const path = `/invoices/passkey?address=${encodeURIComponent(address)}`;
    const json = await this.getJson(path);
    const has = json['hasPasskey'];
    if (typeof has !== 'boolean') {
      throw new GiftsApiError(0, 'malformed passkey response');
    }
    return has;
  }

  /**
   * Live forum-post flag, post UUID, and post timestamp for this Lightning Address.
   *
   * @param address - LUD-16 address.
   * @returns `{ hasPosted, messageId, postedAt }` — `messageId` is a UUID or `null`;
   *   `postedAt` is an ISO-8601 instant or `null` when missing or unparseable.
   */
  async hasPosted(
    address: string,
  ): Promise<{ hasPosted: boolean; messageId: string | null; postedAt: string | null }> {
    const path = `/invoices/posted?address=${encodeURIComponent(address)}`;
    const json = await this.getJson(path);
    const has = json['hasPosted'];
    if (typeof has !== 'boolean') {
      throw new GiftsApiError(0, 'malformed posted response');
    }
    const rawId = json['messageId'];
    const messageId = typeof rawId === 'string' && MESSAGE_ID_RE.test(rawId) ? rawId : null;
    const rawAt = json['postedAt'];
    let postedAt: string | null = null;
    if (typeof rawAt === 'string' && !Number.isNaN(Date.parse(rawAt))) {
      postedAt = new Date(rawAt).toISOString();
    }
    return { hasPosted: has, messageId, postedAt };
  }

  /**
   * Whether 21.gifts reports this Lightning Address as funding-eligible today.
   *
   * @param address - LUD-16 address.
   * @returns `true` when the address is eligible.
   */
  async isFundingEligible(address: string): Promise<boolean> {
    const path = `/invoices/eligible?address=${encodeURIComponent(address)}`;
    const json = await this.getJson(path);
    const eligible = json['eligible'];
    if (typeof eligible !== 'boolean') {
      throw new GiftsApiError(0, 'malformed eligible response');
    }
    return eligible;
  }

  /**
   * Fetch a BOLT11 from 21.gifts for one recipient.
   *
   * @param address - LUD-16 address.
   * @param amountMsat - Amount in millisatoshis.
   * @param amountUsd - Roster USD amount as a two-decimal string (e.g. `"5.00"`); sent as-is.
   * @param comment - Optional LUD-12 comment.
   * @param messageId - Optional forum post UUID; included in the POST body only when provided.
   * @param groupMessageId - Optional Moderators-group message UUID; included in the POST body only when provided.
   * @returns Issued invoice.
   */
  async createInvoice(
    address: string,
    amountMsat: number,
    amountUsd: string,
    comment?: string,
    messageId?: string,
    groupMessageId?: string,
  ): Promise<IssuedInvoice> {
    const body: {
      address: string;
      amountMsat: number;
      amountUsd: string;
      comment?: string;
      messageId?: string;
      groupMessageId?: string;
    } = {
      address,
      amountMsat,
      amountUsd,
    };
    if (comment !== undefined) {
      body.comment = comment;
    }
    if (messageId !== undefined) {
      body.messageId = messageId;
    }
    if (groupMessageId !== undefined) {
      body.groupMessageId = groupMessageId;
    }
    const json = await this.postJson('/invoices', body);
    const id = json['id'];
    const pr = json['pr'];
    const paymentHash = json['paymentHash'];
    const amt = json['amountMsat'];
    if (typeof id !== 'string' || typeof pr !== 'string' || typeof paymentHash !== 'string' || typeof amt !== 'number') {
      throw new GiftsApiError(0, 'malformed invoice response');
    }
    const hash = paymentHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new GiftsApiError(0, 'malformed paymentHash');
    }
    return { id, pr, paymentHash: hash, amountMsat: amt };
  }

  /**
   * Submit the payment preimage as proof.
   *
   * @param id - Invoice id from {@link createInvoice}.
   * @param preimage - 32-byte preimage hex.
   */
  async submitProof(id: string, preimage: string): Promise<void> {
    await this.postJson('/invoices/proof', { id, preimage });
  }

  private async getJson(path: string): Promise<Record<string, unknown>> {
    return this.requestJson(path, { method: 'GET' });
  }

  private async postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.requestJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async requestJson(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.headers ?? {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'network error';
      throw new GiftsApiError(0, message);
    }
    let json: unknown = {};
    try {
      json = await response.json();
    } catch {
      json = {};
    }
    const record = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = typeof record['error'] === 'string' ? record['error'] : `HTTP ${response.status}`;
      throw new GiftsApiError(response.status, error);
    }
    return record;
  }
}
