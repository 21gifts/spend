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
    this.name = "GiftsApiError";
    this.status = status;
  }
}

/** Grant `status` from `GET /invoices/eligible`. */
export type FundingGrantStatus =
  "none" | "pending" | "trial" | "admitted" | "rejected";

const DAILY_SKIP_REASONS = [
  "no_passkey",
  "no_post",
  "no_media",
  "not_eligible",
  "payments_disabled",
  "not_listed",
  "undecided",
  "welcome_paid",
] as const;

/** Skip reason from a 200 `POST /spend/daily-instruction`. */
export type DailyInstructionSkipReason = (typeof DAILY_SKIP_REASONS)[number];

/** 200 body from `POST /spend/daily-instruction`. */
export type DailyInstruction =
  | { action: "skip"; reason: DailyInstructionSkipReason }
  | { action: "pay"; amountUsd: number; comment: string; messageId?: string };

/** One row in a daily-roster document (`recipients` or `moderators`). */
export interface RosterEntry {
  address: string;
  amountUsd: number;
}

/**
 * Full daily-roster document from 21.gifts. `defaultAmountUsd` is the API's
 * number; Spend does not invent it.
 */
export interface RosterDocument {
  comment: string;
  paymentsEnabled: boolean;
  moderatorPaymentsEnabled: boolean;
  defaultAmountUsd: number;
  recipients: RosterEntry[];
  moderators: RosterEntry[];
}

/** POST body for `POST /funding/daily-roster/document`. No `defaultAmountUsd`. */
export interface RosterImportBody {
  comment: string;
  paymentsEnabled: boolean;
  moderatorPaymentsEnabled: boolean;
  recipients: RosterEntry[];
  moderators: RosterEntry[];
}

function isDailySkipReason(
  value: unknown,
): value is DailyInstructionSkipReason {
  return (
    typeof value === "string" &&
    (DAILY_SKIP_REASONS as readonly string[]).includes(value)
  );
}

function parseRosterEntries(raw: unknown): RosterEntry[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const rows: RosterEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const rec = item as Record<string, unknown>;
    const address = rec["address"];
    const amountUsd = rec["amountUsd"];
    if (
      typeof address !== "string" ||
      typeof amountUsd !== "number" ||
      !Number.isFinite(amountUsd) ||
      amountUsd <= 0
    ) {
      return null;
    }
    rows.push({ address, amountUsd });
  }
  return rows;
}

function parseRosterDocument(json: Record<string, unknown>): RosterDocument {
  if (Array.isArray(json)) {
    throw new GiftsApiError(0, "malformed roster");
  }
  const comment = json["comment"];
  const paymentsEnabled = json["paymentsEnabled"];
  const moderatorPaymentsEnabled = json["moderatorPaymentsEnabled"];
  const defaultAmountUsd = json["defaultAmountUsd"];
  const recipients = parseRosterEntries(json["recipients"]);
  const moderators = parseRosterEntries(json["moderators"]);
  if (typeof comment !== "string") {
    throw new GiftsApiError(0, "malformed roster");
  }
  if (
    typeof paymentsEnabled !== "boolean" ||
    typeof moderatorPaymentsEnabled !== "boolean"
  ) {
    throw new GiftsApiError(0, "malformed roster");
  }
  if (
    typeof defaultAmountUsd !== "number" ||
    !Number.isFinite(defaultAmountUsd)
  ) {
    throw new GiftsApiError(0, "malformed roster");
  }
  if (recipients === null || moderators === null) {
    throw new GiftsApiError(0, "malformed roster");
  }
  return {
    comment,
    paymentsEnabled,
    moderatorPaymentsEnabled,
    defaultAmountUsd,
    recipients,
    moderators,
  };
}

/**
 * Client for `POST /spend/daily-instruction`, the daily-roster document and
 * worker routes, `GET /invoices/eligible` (grant status), `POST /invoices`,
 * and `POST /invoices/proof`.
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
    const json = await this.postJson("/spend/daily-instruction", { address });
    const action = json["action"];
    if (action === "skip") {
      const reason = json["reason"];
      if (!isDailySkipReason(reason)) {
        throw new GiftsApiError(0, "malformed daily instruction");
      }
      return { action: "skip", reason };
    }
    if (action === "pay") {
      const amountUsd = json["amountUsd"];
      const comment = json["comment"];
      if (
        typeof amountUsd !== "number" ||
        !Number.isFinite(amountUsd) ||
        amountUsd <= 0
      ) {
        throw new GiftsApiError(0, "malformed daily instruction");
      }
      if (typeof comment !== "string") {
        throw new GiftsApiError(0, "malformed daily instruction");
      }
      const rawId = json["messageId"];
      if (rawId === undefined || rawId === "") {
        return { action: "pay", amountUsd, comment };
      }
      if (typeof rawId !== "string") {
        throw new GiftsApiError(0, "malformed daily instruction");
      }
      return { action: "pay", amountUsd, comment, messageId: rawId };
    }
    throw new GiftsApiError(0, "malformed daily instruction");
  }

  /**
   * Import a live-file payload as the API roster document. The API no-ops when
   * it already has a document and returns the stored document.
   *
   * @param body - File fields without `defaultAmountUsd`.
   * @returns The full stored document.
   */
  async importRosterDocument(body: RosterImportBody): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/document", {
      comment: body.comment,
      paymentsEnabled: body.paymentsEnabled,
      moderatorPaymentsEnabled: body.moderatorPaymentsEnabled,
      recipients: body.recipients,
      moderators: body.moderators,
    });
  }

  /**
   * Set the file-level payment comment.
   *
   * @param comment - New comment (API validates).
   * @returns The full stored document.
   */
  async setRosterComment(comment: string): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/worker/comment", { comment });
  }

  /**
   * Set the daily-payments switch.
   *
   * @param enabled - New switch value (API validates).
   * @returns The full stored document.
   */
  async setRosterPayments(enabled: boolean): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/worker/payments", {
      enabled,
    });
  }

  /**
   * Add a daily recipient.
   *
   * @param address - Lightning Address.
   * @param amountUsd - USD amount.
   * @returns The full stored document.
   */
  async addRosterRecipient(
    address: string,
    amountUsd: number,
  ): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/worker/recipients", {
      address,
      amountUsd,
    });
  }

  /**
   * Update a daily recipient amount.
   *
   * @param address - Lightning Address.
   * @param amountUsd - USD amount.
   * @returns The full stored document.
   */
  async updateRosterRecipient(
    address: string,
    amountUsd: number,
  ): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/worker/recipients/update", {
      address,
      amountUsd,
    });
  }

  /**
   * Delete a daily recipient.
   *
   * @param address - Lightning Address.
   * @returns The full stored document.
   */
  async deleteRosterRecipient(address: string): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/worker/recipients/delete", {
      address,
    });
  }

  /**
   * Add a moderator.
   *
   * @param address - Lightning Address.
   * @param amountUsd - USD amount.
   * @returns The full stored document.
   */
  async addRosterModerator(
    address: string,
    amountUsd: number,
  ): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/worker/moderators", {
      address,
      amountUsd,
    });
  }

  /**
   * Update a moderator amount.
   *
   * @param address - Lightning Address.
   * @param amountUsd - USD amount.
   * @returns The full stored document.
   */
  async updateRosterModerator(
    address: string,
    amountUsd: number,
  ): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/worker/moderators/update", {
      address,
      amountUsd,
    });
  }

  /**
   * Delete a moderator.
   *
   * @param address - Lightning Address.
   * @returns The full stored document.
   */
  async deleteRosterModerator(address: string): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/worker/moderators/delete", {
      address,
    });
  }

  /**
   * Set the moderator-payments switch.
   *
   * @param enabled - New switch value (API validates).
   * @returns The full stored document.
   */
  async setRosterModeratorPayments(enabled: boolean): Promise<RosterDocument> {
    return this.postRoster("/funding/daily-roster/worker/moderators/payments", {
      enabled,
    });
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
    const status = json["status"];
    if (
      status !== "none" &&
      status !== "pending" &&
      status !== "trial" &&
      status !== "admitted" &&
      status !== "rejected"
    ) {
      throw new GiftsApiError(0, "malformed eligible status");
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
    const json = await this.postJson("/invoices", body);
    const id = json["id"];
    const pr = json["pr"];
    const paymentHash = json["paymentHash"];
    const amt = json["amountMsat"];
    if (
      typeof id !== "string" ||
      typeof pr !== "string" ||
      typeof paymentHash !== "string" ||
      typeof amt !== "number"
    ) {
      throw new GiftsApiError(0, "malformed invoice response");
    }
    const hash = paymentHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new GiftsApiError(0, "malformed paymentHash");
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
    await this.postJson("/invoices/proof", { id, preimage });
  }

  private async getJson(path: string): Promise<Record<string, unknown>> {
    return this.requestJson(path, { method: "GET" });
  }

  private async postJson(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.requestJson(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async postRoster(
    path: string,
    body: unknown,
  ): Promise<RosterDocument> {
    return parseRosterDocument(await this.postJson(path, body));
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
      const message = err instanceof Error ? err.message : "network error";
      throw new GiftsApiError(0, message);
    }
    let json: unknown = {};
    try {
      json = await response.json();
    } catch {
      json = {};
    }
    const record =
      json !== null && typeof json === "object"
        ? (json as Record<string, unknown>)
        : {};
    if (!response.ok) {
      const error =
        typeof record["error"] === "string"
          ? record["error"]
          : `HTTP ${response.status}`;
      throw new GiftsApiError(response.status, error);
    }
    return record;
  }
}
