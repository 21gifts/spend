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

/** Grant `status` from `GET /invoices/eligible`. */
export type FundingGrantStatus = 'none' | 'pending' | 'trial' | 'admitted' | 'rejected';

const DAILY_SKIP_REASONS = [
  'no_passkey',
  'no_post',
  'no_media',
  'not_eligible',
  'payments_disabled',
  'not_listed',
  'undecided',
  'welcome_paid',
] as const;

/** Skip reason from a 200 `POST /spend/daily-instruction`. */
export type DailyInstructionSkipReason = (typeof DAILY_SKIP_REASONS)[number];

/** 200 body from `POST /spend/daily-instruction`. */
export type DailyInstruction =
  | { action: 'skip'; reason: DailyInstructionSkipReason }
  | { action: 'pay'; amountUsd: number; comment: string; messageId?: string };

function isDailySkipReason(value: unknown): value is DailyInstructionSkipReason {
  return typeof value === 'string' && (DAILY_SKIP_REASONS as readonly string[]).includes(value);
}

/**
 * Client for `POST /spend/daily-instruction`, `GET /invoices/eligible` (grant status),
 * `POST /invoices`, and `POST /invoices/proof`.
 */
export class GiftsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Ask 21.gifts whether to pay this Lightning Address today, and how much.
   *
   * @param address - LUD-16 address.
   * @returns A skip reason or a pay instruction.
   */
  async dailyInstruction(address: string): Promise<DailyInstruction> {
    const json = await this.postJson('/spend/daily-instruction', { address });
    const action = json['action'];
    if (action === 'skip') {
      const reason = json['reason'];
      if (!isDailySkipReason(reason)) {
        throw new GiftsApiError(0, 'malformed daily instruction');
      }
      return { action: 'skip', reason };
    }
    if (action === 'pay') {
      const amountUsd = json['amountUsd'];
      const comment = json['comment'];
      if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
        throw new GiftsApiError(0, 'malformed daily instruction');
      }
      if (typeof comment !== 'string') {
        throw new GiftsApiError(0, 'malformed daily instruction');
      }
      const rawId = json['messageId'];
      if (rawId === undefined || rawId === '') {
        return { action: 'pay', amountUsd, comment };
      }
      if (typeof rawId !== 'string') {
        throw new GiftsApiError(0, 'malformed daily instruction');
      }
      return { action: 'pay', amountUsd, comment, messageId: rawId };
    }
    throw new GiftsApiError(0, 'malformed daily instruction');
  }

  /**
   * Funding-grant status 21.gifts reports for this Lightning Address.
   *
   * @param address - LUD-16 address.
   * @returns Grant `status` from `GET /invoices/eligible`.
   */
  async fundingGrantStatus(address: string): Promise<FundingGrantStatus> {
    const path = `/invoices/eligible?address=${encodeURIComponent(address)}`;
    const json = await this.getJson(path);
    const status = json['status'];
    if (
      status !== 'none' &&
      status !== 'pending' &&
      status !== 'trial' &&
      status !== 'admitted' &&
      status !== 'rejected'
    ) {
      throw new GiftsApiError(0, 'malformed eligible status');
    }
    return status;
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
