/** In-memory 21.gifts daily-roster API for Playwright. */

const hostname = "127.0.0.1";
const port = Number(process.env["MOCK_ROSTER_PORT"] ?? 3999);
const TOKEN = "e2e-token";

type RosterEntry = { address: string; amountUsd: number };

type RosterDocument = {
  comment: string;
  paymentsEnabled: boolean;
  moderatorPaymentsEnabled: boolean;
  defaultAmountUsd: number;
  recipients: RosterEntry[];
  moderators: RosterEntry[];
};

let stored: RosterDocument | null = null;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bearerOk(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${TOKEN}`;
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

function cloneDocument(doc: RosterDocument): RosterDocument {
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

function asEntries(raw: unknown): RosterEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows: RosterEntry[] = [];
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
  list: RosterEntry[],
  body: Record<string, unknown>,
): { ok: true; list: RosterEntry[] } | { ok: false; error: string } {
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

function ensureStored(): RosterDocument {
  if (stored === null) {
    stored = {
      comment: "",
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [],
      moderators: [],
    };
  }
  return stored;
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function importDocument(body: unknown): Response {
  if (stored !== null) {
    return jsonResponse(200, cloneDocument(stored));
  }
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  stored = {
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
  return jsonResponse(200, cloneDocument(stored));
}

function worker(path: string, body: unknown): Response {
  const doc = ensureStored();
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
  return new Response("not found", { status: 404 });
}

const server = Bun.serve({
  hostname,
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    if (!bearerOk(req)) {
      return jsonResponse(401, { error: "Unauthorized" });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/funding/daily-roster/document"
    ) {
      return importDocument(await readBody(req));
    }
    const prefix = "/funding/daily-roster/worker/";
    if (req.method === "POST" && url.pathname.startsWith(prefix)) {
      return worker(url.pathname.slice(prefix.length), await readBody(req));
    }
    return new Response("not found", { status: 404 });
  },
});

console.warn(
  JSON.stringify({
    ts: new Date().toISOString(),
    event: "mock-roster-api.listen",
    hostname: server.hostname,
    port: server.port,
  }),
);
