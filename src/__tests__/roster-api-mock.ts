/** In-memory 21.gifts daily-roster stand-in for unit tests. */

export type MockRosterEntry = { address: string; amountUsd: number };

export type MockRosterDocument = {
  comment: string;
  paymentsEnabled: boolean;
  moderatorPaymentsEnabled: boolean;
  defaultAmountUsd: number;
  recipients: MockRosterEntry[];
  moderators: MockRosterEntry[];
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseComment(
  raw: unknown,
): { ok: true; comment: string } | { ok: false } {
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const comment = raw.replace(/\r\n|\n|\r/g, " ").trim();
  if (comment.length > 500) {
    return { ok: false };
  }
  return { ok: true, comment };
}

function parseAddress(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const address = raw.trim();
  if (address === "" || !address.includes("@")) {
    return null;
  }
  return address;
}

function parseAmountUsd(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw;
}

function cloneDocument(doc: MockRosterDocument): MockRosterDocument {
  return {
    comment: doc.comment,
    paymentsEnabled: doc.paymentsEnabled,
    moderatorPaymentsEnabled: doc.moderatorPaymentsEnabled,
    defaultAmountUsd: doc.defaultAmountUsd,
    recipients: doc.recipients.map((row) => ({
      address: row.address,
      amountUsd: row.amountUsd,
    })),
    moderators: doc.moderators.map((row) => ({
      address: row.address,
      amountUsd: row.amountUsd,
    })),
  };
}

function asEntries(raw: unknown): MockRosterEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows: MockRosterEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const rec = item as { address?: unknown; amountUsd?: unknown };
    if (typeof rec.address !== "string" || typeof rec.amountUsd !== "number") {
      continue;
    }
    rows.push({ address: rec.address, amountUsd: rec.amountUsd });
  }
  return rows;
}

function mutateList(
  action: "add" | "update" | "delete",
  list: MockRosterEntry[],
  body: Record<string, unknown>,
): { ok: true; list: MockRosterEntry[] } | { ok: false; error: string } {
  if (action === "add") {
    const address = parseAddress(body["address"]);
    const amountUsd = parseAmountUsd(body["amountUsd"]);
    if (address === null || amountUsd === null) {
      return { ok: false, error: "Invalid address or amount" };
    }
    if (
      list.some((row) => row.address.toLowerCase() === address.toLowerCase())
    ) {
      return { ok: false, error: "Address already listed" };
    }
    return { ok: true, list: [...list, { address, amountUsd }] };
  }
  if (action === "update") {
    const address = parseAddress(body["address"]);
    if (address === null) {
      return { ok: false, error: "Unknown address" };
    }
    const idx = list.findIndex((row) => row.address === address);
    if (idx < 0) {
      return { ok: false, error: "Unknown address" };
    }
    const amountUsd = parseAmountUsd(body["amountUsd"]);
    if (amountUsd === null) {
      return { ok: false, error: "Invalid address or amount" };
    }
    const current = list[idx];
    if (current === undefined) {
      return { ok: false, error: "Unknown address" };
    }
    return {
      ok: true,
      list: list.map((row, i) => (i === idx ? { ...current, amountUsd } : row)),
    };
  }
  const address = parseAddress(body["address"]);
  if (address === null) {
    return { ok: false, error: "Unknown address" };
  }
  const next = list.filter((row) => row.address !== address);
  if (next.length === list.length) {
    return { ok: false, error: "Unknown address" };
  }
  return { ok: true, list: next };
}

function workerPath(pathname: string): string | null {
  const prefix = "/funding/daily-roster/worker/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  return pathname.slice(prefix.length);
}

class InMemoryRosterApi {
  private stored: MockRosterDocument | null = null;

  handle(pathname: string, body: unknown): Response | null {
    if (pathname === "/funding/daily-roster/document") {
      return this.importDocument(body);
    }
    const worker = workerPath(pathname);
    if (worker === null) {
      return null;
    }
    return this.worker(worker, body);
  }

  private importDocument(body: unknown): Response {
    if (this.stored !== null) {
      return jsonResponse(200, cloneDocument(this.stored));
    }
    const record =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    this.stored = {
      comment: typeof record["comment"] === "string" ? record["comment"] : "",
      paymentsEnabled:
        typeof record["paymentsEnabled"] === "boolean"
          ? record["paymentsEnabled"]
          : true,
      moderatorPaymentsEnabled:
        typeof record["moderatorPaymentsEnabled"] === "boolean"
          ? record["moderatorPaymentsEnabled"]
          : true,
      defaultAmountUsd:
        typeof record["defaultAmountUsd"] === "number" &&
        Number.isFinite(record["defaultAmountUsd"])
          ? record["defaultAmountUsd"]
          : 1,
      recipients: asEntries(record["recipients"]),
      moderators: asEntries(record["moderators"]),
    };
    return jsonResponse(200, cloneDocument(this.stored));
  }

  private worker(path: string, body: unknown): Response | null {
    const doc =
      this.stored ??
      ({
        comment: "",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [],
        moderators: [],
      } satisfies MockRosterDocument);
    this.stored = doc;
    const record =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    if (path === "comment") {
      const parsed = parseComment(record["comment"]);
      if (!parsed.ok) {
        return jsonResponse(400, { error: "Invalid comment" });
      }
      doc.comment = parsed.comment;
      return jsonResponse(200, cloneDocument(doc));
    }
    if (path === "payments") {
      if (typeof record["enabled"] !== "boolean") {
        return jsonResponse(400, { error: "Invalid payments switch" });
      }
      doc.paymentsEnabled = record["enabled"];
      return jsonResponse(200, cloneDocument(doc));
    }
    if (path === "moderators/payments") {
      if (typeof record["enabled"] !== "boolean") {
        return jsonResponse(400, { error: "Invalid payments switch" });
      }
      doc.moderatorPaymentsEnabled = record["enabled"];
      return jsonResponse(200, cloneDocument(doc));
    }
    const recipientAction =
      path === "recipients/update"
        ? "update"
        : path === "recipients/delete"
          ? "delete"
          : path === "recipients"
            ? "add"
            : null;
    if (recipientAction !== null) {
      const mutated = mutateList(recipientAction, doc.recipients, record);
      if (!mutated.ok) {
        return jsonResponse(400, { error: mutated.error });
      }
      doc.recipients = mutated.list;
      return jsonResponse(200, cloneDocument(doc));
    }
    const moderatorAction =
      path === "moderators/update"
        ? "update"
        : path === "moderators/delete"
          ? "delete"
          : path === "moderators"
            ? "add"
            : null;
    if (moderatorAction !== null) {
      const mutated = mutateList(moderatorAction, doc.moderators, record);
      if (!mutated.ok) {
        return jsonResponse(400, { error: mutated.error });
      }
      doc.moderators = mutated.list;
      return jsonResponse(200, cloneDocument(doc));
    }
    return null;
  }
}

function pathnameOf(input: Parameters<typeof fetch>[0]): string {
  const raw =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
  return new URL(raw, "http://local").pathname;
}

function parseBody(init?: RequestInit): unknown {
  if (init?.body === undefined || init.body === null) {
    return {};
  }
  const text = typeof init.body === "string" ? init.body : String(init.body);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/**
 * Fetch wrapper that answers `POST /funding/daily-roster/document` and the nine
 * worker routes against one in-memory document. Unknown URLs go to `inner`, or
 * `{}` 200 when `inner` is omitted. The stored `1` is this stand-in API's
 * defaultAmountUsd, not a Spend constant.
 *
 * @param inner - Fetch used for non-roster URLs.
 * @returns A `fetch` implementation.
 */
export function withRosterApi(inner?: typeof fetch): typeof fetch {
  const api = new InMemoryRosterApi();
  return async (input, init) => {
    const handled = api.handle(pathnameOf(input), parseBody(init));
    if (handled !== null) {
      return handled;
    }
    if (inner !== undefined) {
      return inner(input, init);
    }
    return new Response("{}", { status: 200 });
  };
}
