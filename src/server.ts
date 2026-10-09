import { readFileSync } from "node:fs";
import { loadConfig, type Recipient, type SpendConfig } from "./config";
import { loadDashboard } from "./dashboard";
import { bearerMatchesDebugToken, bearerMatchesToken } from "./debug-token";
import {
  GiftsApi,
  GiftsApiError,
  type RosterDocument,
  type RosterImportBody,
} from "./gifts-api";
import { parseLightningAddress } from "./lightning-address";
import { LndhubClient, parseLndhubUri } from "./lndhub";
import { createPayoutGate } from "./payout-gate";
import { fetchBtcUsdSpot } from "./price";
import {
  CorruptRecipientsError,
  ensureLiveRecipients,
  loadLiveRecipients,
  type LiveRecipients,
} from "./recipients-store";
import {
  renderDashboardHtml,
  renderUnconfiguredHtml,
  type SpendPanel,
} from "./recipients-html";
import { runDay, type RunOptions } from "./run";
import {
  SESSION_TTL_SEC,
  clearSessionCookie,
  mintSessionCookie,
  passwordsMatch,
  sessionCookieHeader,
  sessionCookieValid,
} from "./session";
import { appendRetryOwed, loadRetryOwed, type RetryOwed } from "./retry-queue";
import {
  CorruptStateError,
  DayState,
  dayBlock,
  latestStatus,
  type StateRow,
} from "./state";
import {
  loadTelegram,
  minimalRunSummary,
  notifyPayout,
  TelegramDedupe,
  type RunSummary,
  type TelegramSource,
} from "./telegram";

const SERVICE_NAME = "spend";
const MESSAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROSTER_UNAVAILABLE = "Daily roster is unavailable";

/**
 * Parse `BIND_ADDR` (`host:port`).
 *
 * @param raw - Env value.
 * @returns Hostname and port.
 */
export function parseBindAddr(raw: string | undefined): {
  hostname: string;
  port: number;
} {
  const value =
    raw === undefined || raw.trim() === "" ? "0.0.0.0:3000" : raw.trim();
  const idx = value.lastIndexOf(":");
  if (idx <= 0 || idx === value.length - 1) {
    return { hostname: "0.0.0.0", port: 3000 };
  }
  const hostname = value.slice(0, idx);
  const port = Number(value.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { hostname: "0.0.0.0", port: 3000 };
  }
  return { hostname, port };
}

function serviceVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function htmlResponse(
  body: string,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function redirect(location: string, headers?: HeadersInit): Response {
  return new Response(null, {
    status: 303,
    headers: { location, ...headers },
  });
}

async function readForm(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    return new URLSearchParams(text);
  }
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const params = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        params.set(key, value);
      }
    }
    return params;
  }
  const text = await req.text();
  return new URLSearchParams(text);
}

/**
 * Explicit ping amount. A present `amountUsd` key requires a finite number
 * greater than 0 and a comment string of length at most 500, paid as-is.
 * Absent or invalid both 400 at the ping handler.
 *
 * @param body - Parsed JSON object.
 * @returns Absent when the key is missing, invalid when the pair is unusable.
 */
function parsePingInstruction(
  body: object,
):
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "ok"; amountUsd: number; comment: string } {
  if (!("amountUsd" in body)) {
    return { status: "absent" };
  }
  const amountUsd = (body as { amountUsd: unknown }).amountUsd;
  const comment = (body as { comment?: unknown }).comment;
  if (
    typeof comment !== "string" ||
    comment.length > 500 ||
    typeof amountUsd !== "number" ||
    !Number.isFinite(amountUsd) ||
    amountUsd <= 0
  ) {
    return { status: "invalid" };
  }
  return { status: "ok", amountUsd, comment };
}

type DailyRosterJson = {
  comment: string;
  paymentsEnabled: boolean;
  defaultAmountUsd: number;
  recipients: Array<{ address: string; amountUsd: number }>;
  moderators: Array<{ address: string; amountUsd: number }>;
  moderatorPaymentsEnabled: boolean;
};

/**
 * GET `/daily-roster` payload from the API document. `defaultAmountUsd` is the
 * API field. No per-row comment.
 *
 * @param doc - Full roster document from 21.gifts.
 * @returns JSON body for GET and successful daily-roster POSTs.
 */
function toDailyRosterJson(doc: RosterDocument): DailyRosterJson {
  return {
    comment: doc.comment,
    paymentsEnabled: doc.paymentsEnabled,
    defaultAmountUsd: doc.defaultAmountUsd,
    recipients: doc.recipients.map((row) => ({
      address: row.address,
      amountUsd: row.amountUsd,
    })),
    moderators: doc.moderators.map((row) => ({
      address: row.address,
      amountUsd: row.amountUsd,
    })),
    moderatorPaymentsEnabled: doc.moderatorPaymentsEnabled,
  };
}

function importRosterBody(live: LiveRecipients): RosterImportBody {
  return {
    comment: live.comment,
    paymentsEnabled: live.paymentsEnabled,
    moderatorPaymentsEnabled: live.moderatorPaymentsEnabled,
    recipients: live.recipients.map((row) => ({
      address: row.address,
      amountUsd: row.amountUsd,
    })),
    moderators: live.moderators.map((row) => ({
      address: row.address,
      amountUsd: row.amountUsd,
    })),
  };
}

function rosterUnavailableJson(): Response {
  return jsonResponse(502, { error: ROSTER_UNAVAILABLE });
}

function rosterUnavailableHtml(): Response {
  return new Response(ROSTER_UNAVAILABLE, { status: 502 });
}

type RosterStop =
  | { ok: false; status: 400 | 401; error: string }
  | { ok: false; status: 502 };

/** A roster-API 400 or 401 is that status. Anything else stays unavailable. */
function rosterStop(err: unknown): RosterStop {
  if (
    err instanceof GiftsApiError &&
    (err.status === 400 || err.status === 401)
  ) {
    return { ok: false, status: err.status, error: err.message };
  }
  return { ok: false, status: 502 };
}

function rosterStopJson(stop: RosterStop): Response {
  if (stop.status === 502) {
    return rosterUnavailableJson();
  }
  return jsonResponse(stop.status, { error: stop.error });
}

function rosterStopHtml(stop: RosterStop): Response {
  if (stop.status === 502) {
    return rosterUnavailableHtml();
  }
  return new Response(stop.error, { status: stop.status });
}

const DAILY_ROSTER_POST =
  /^\/daily-roster\/(comment|payments|recipients|recipients\/update|recipients\/delete)$/;

/**
 * HTTP app for the dashboard, daily-roster JSON API, health probe, operator debug, and ping-triggered payouts.
 *
 * @param opts - Env, fetch, clock, and optional `retryCatchupMs` (overrides `RETRY_CATCHUP_MS`).
 * @returns Fetch handler, no-op midnight scheduler and boot catch-up, retry catch-up for owed `insufficient_balance` addresses when live and the interval is enabled, payout runner, and payout drain.
 */
export function createServer(opts: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  retryCatchupMs?: number;
  runDay?: (
    config: SpendConfig,
    options: RunOptions,
  ) => Promise<{ exitCode: number }>;
}): {
  fetch: (req: Request) => Promise<Response>;
  startScheduler: () => { stop: () => void };
  startCatchup: () => Promise<{ exitCode: number } | null>;
  startRetryCatchup: () => { stop: () => void };
  runPayout: (day: string) => Promise<{ exitCode: number }>;
  drainPayouts: () => Promise<void>;
} {
  const loaded = loadConfig(opts.env);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const telegram = loadTelegram(opts.env);
  if (!telegram.ok) {
    throw new Error(telegram.error);
  }
  const telegramTarget = telegram.target;
  const notifyLog = new TelegramDedupe();
  const config = loaded.config;
  /* v8 ignore start — seed was already parsed by loadConfig; copy is best-effort. */
  try {
    ensureLiveRecipients(config.stateDir, config.recipientsFile);
  } catch {
    // Seed copy is best-effort; payout still fail-closes on a bad live file.
  }
  /* v8 ignore stop */
  const fetchImpl = opts.fetchImpl ?? fetch;
  const gifts = new GiftsApi(
    config.giftsApiUrl,
    config.giftsApiToken,
    fetchImpl,
  );
  const live = opts.env["SPEND_LIVE"] === "true";
  const debugToken = opts.env["DEBUG_TOKEN"];
  const target = parseLndhubUri(config.lndhubUri);
  if (target === null) {
    throw new Error("LNDHUB_URI must be an lndhub:// URI");
  }
  const lndhub = new LndhubClient(target, fetchImpl);
  const version = serviceVersion();
  const recipientsGate = createPayoutGate();
  const sessionNow = (): number =>
    (opts.now ?? (() => new Date()))().getTime() / 1000;

  const requireSession = (req: Request): boolean => {
    const password = config.dashboardPassword;
    if (password === null) {
      return false;
    }
    return sessionCookieValid(req.headers.get("cookie"), password, sessionNow);
  };

  const requireSameOrigin = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    if (origin === null || origin === "") {
      return false;
    }
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    const host =
      (req.headers.get("host") ?? new URL(req.url).host)
        .split(",")[0]
        ?.trim() ?? "";
    return host !== "" && originHost === host;
  };

  const loadDashboardData = () =>
    loadDashboard({
      lndhub,
      btcUsd: () => fetchBtcUsdSpot(fetchImpl),
      lightningAddress: config.lightningAddress,
    });

  /** Load dashboard then render the combined page (optional panel). */
  const combinedPage = async (panel?: SpendPanel): Promise<Response> => {
    const data = await loadDashboardData();
    return htmlResponse(renderDashboardHtml(data, panel));
  };

  /** Load dashboard then render Spend + unconfigured notice (HTTP 503). */
  const unconfiguredPage = async (): Promise<Response> => {
    const data = await loadDashboardData();
    return htmlResponse(renderUnconfiguredHtml(data), 503);
  };

  const loadOrError = ():
    ({ ok: true } & LiveRecipients) | { ok: false; response: Response } => {
    try {
      const liveList = loadLiveRecipients(config.stateDir);
      return {
        ok: true,
        comment: liveList.comment,
        recipients: liveList.recipients,
        moderators: liveList.moderators,
        paymentsEnabled: liveList.paymentsEnabled,
        moderatorPaymentsEnabled: liveList.moderatorPaymentsEnabled,
      };
    } catch (err) {
      if (err instanceof CorruptRecipientsError) {
        return {
          ok: false,
          response: new Response("Recipient list is unreadable", {
            status: 500,
          }),
        };
      }
      throw err;
    }
  };

  const loadLiveJson = ():
    ({ ok: true } & LiveRecipients) | { ok: false; response: Response } => {
    try {
      const liveList = loadLiveRecipients(config.stateDir);
      return {
        ok: true,
        comment: liveList.comment,
        recipients: liveList.recipients,
        moderators: liveList.moderators,
        paymentsEnabled: liveList.paymentsEnabled,
        moderatorPaymentsEnabled: liveList.moderatorPaymentsEnabled,
      };
    } catch (err) {
      if (err instanceof CorruptRecipientsError) {
        return {
          ok: false,
          response: jsonResponse(500, {
            error: "Recipient list is unreadable",
          }),
        };
      }
      throw err;
    }
  };

  const importDocument = async (
    liveList: LiveRecipients,
  ): Promise<{ ok: true; doc: RosterDocument } | RosterStop> => {
    try {
      const doc = await gifts.importRosterDocument(importRosterBody(liveList));
      return { ok: true, doc };
    } catch (err) {
      return rosterStop(err);
    }
  };

  const callWorker = async (
    run: () => Promise<RosterDocument>,
  ): Promise<{ ok: true; doc: RosterDocument } | RosterStop> => {
    try {
      const doc = await run();
      return { ok: true, doc };
    } catch (err) {
      return rosterStop(err);
    }
  };

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      url.pathname === "/healthz"
    ) {
      const body = JSON.stringify({
        status: "ok",
        service: SERVICE_NAME,
        version,
      });
      return new Response(req.method === "HEAD" ? null : body, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      url.pathname === "/debug/recipients"
    ) {
      const json = (status: number, payload: unknown): Response =>
        new Response(req.method === "HEAD" ? null : JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      if (debugToken === undefined || debugToken.trim() === "") {
        return json(503, { error: "Debug is not configured" });
      }
      if (
        !bearerMatchesDebugToken(
          debugToken,
          req.headers.get("authorization") ?? undefined,
        )
      ) {
        return json(401, { error: "Unauthorized" });
      }
      try {
        const liveList = loadLiveRecipients(config.stateDir);
        const imported = await importDocument(liveList);
        if (!imported.ok) {
          if (imported.status === 502) {
            return json(502, { error: ROSTER_UNAVAILABLE });
          }
          return json(imported.status, { error: imported.error });
        }
        const doc = imported.doc;
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "spend.debug.recipients",
            count: doc.recipients.length,
          }),
        );
        return json(200, {
          comment: doc.comment,
          recipients: doc.recipients,
          moderators: doc.moderators,
          paymentsEnabled: doc.paymentsEnabled,
          moderatorPaymentsEnabled: doc.moderatorPaymentsEnabled,
        });
      } catch (err) {
        if (err instanceof CorruptRecipientsError) {
          return json(500, { error: "Recipient list is unreadable" });
        }
        throw err;
      }
    }
    if (req.method === "POST" && url.pathname === "/ping") {
      const json = (status: number, payload: unknown): Response =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      if (
        !bearerMatchesToken(
          config.giftsApiToken,
          req.headers.get("authorization") ?? undefined,
        )
      ) {
        return json(401, { error: "Unauthorized" });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "Expected a JSON body with address" });
      }
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !("address" in body) ||
        typeof (body as { address: unknown }).address !== "string"
      ) {
        return json(400, { error: "Expected a JSON body with address" });
      }
      const pingBody = body as {
        address: string;
        messageId?: unknown;
        kind?: unknown;
        groupMessageId?: unknown;
      };
      const kindRaw = pingBody.kind;
      if (
        kindRaw !== undefined &&
        kindRaw !== "daily" &&
        kindRaw !== "moderator" &&
        kindRaw !== "welcome"
      ) {
        return json(400, {
          error: "Expected a JSON body with address and kind",
        });
      }
      const kind: "daily" | "moderator" | "welcome" =
        kindRaw === "moderator"
          ? "moderator"
          : kindRaw === "welcome"
            ? "welcome"
            : "daily";
      let groupMessageId: string | undefined;
      if (kind === "moderator") {
        if ("messageId" in pingBody) {
          return json(400, {
            error: "Expected a JSON body with address and kind",
          });
        }
        const rawGroupMessageId = pingBody.groupMessageId;
        if (rawGroupMessageId !== undefined) {
          if (
            typeof rawGroupMessageId !== "string" ||
            !MESSAGE_ID_RE.test(rawGroupMessageId)
          ) {
            return json(400, {
              error: "Expected a JSON body with address and kind",
            });
          }
          groupMessageId = rawGroupMessageId;
        }
      } else if (
        kind === "daily" &&
        (typeof pingBody.messageId !== "string" ||
          !MESSAGE_ID_RE.test(pingBody.messageId))
      ) {
        return json(400, {
          error: "Expected a JSON body with address and messageId",
        });
      }
      const parsed = parseLightningAddress(pingBody.address);
      if (parsed === null) {
        return json(400, {
          error: "Not a valid Lightning Address (expected name@domain)",
        });
      }
      if (kind === "welcome") {
        if (
          typeof pingBody.messageId !== "string" ||
          !MESSAGE_ID_RE.test(pingBody.messageId)
        ) {
          return json(400, {
            error: "Expected a JSON body with address and messageId",
          });
        }
      }
      const instruction = parsePingInstruction(body as object);
      if (instruction.status !== "ok") {
        return json(400, {
          error: "Expected a JSON body with address, amountUsd, and comment",
        });
      }
      const logPing = (status: string, reason?: string): void => {
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "spend.ping",
            address: parsed,
            status,
            ...(reason !== undefined ? { reason } : {}),
            ...(kind === "daily" ? {} : { kind }),
          }),
        );
      };
      const clock = opts.now ?? (() => new Date());
      const day = clock().toISOString().slice(0, 10);
      let storedAddress = parsed;
      let rows;
      try {
        rows =
          kind === "welcome" || kind === "moderator"
            ? new DayState(config.stateDir, day, undefined, kind).load()
            : new DayState(config.stateDir, day).load();
      } catch (err) {
        if (!(err instanceof CorruptStateError)) {
          throw err;
        }
        rows = undefined;
      }
      if (rows !== undefined) {
        if (kind === "welcome" || kind === "moderator") {
          const persisted = rows.find(
            (row) => row.address.toLowerCase() === parsed.toLowerCase(),
          );
          if (persisted !== undefined) {
            storedAddress = persisted.address;
          }
        }
        const block = dayBlock(rows, storedAddress);
        if (block === "paid") {
          logPing("skipped", "paid");
          return json(200, { status: "skipped", reason: "paid" });
        }
        if (
          block === "uncertain" ||
          (kind === "daily" && dayBlock(rows, "*halt*") === "uncertain")
        ) {
          logPing("skipped", "uncertain");
          return json(200, { status: "skipped", reason: "uncertain" });
        }
        if (latestStatus(rows, storedAddress) === "failed") {
          logPing("skipped", "failed");
          return json(200, { status: "skipped", reason: "failed" });
        }
      }
      logPing("accepted");
      const instructedRow: Recipient = {
        address: storedAddress,
        amountUsd: instruction.amountUsd,
        comment: instruction.comment,
      };
      const messageId =
        kind === "moderator" ? undefined : (pingBody.messageId as string);
      void payout(day, "ping", [storedAddress], messageId, {
        recipients: [instructedRow],
        comment: instruction.comment,
        ...(kind === "welcome" || kind === "moderator" ? { bucket: kind } : {}),
        ...(groupMessageId === undefined ? {} : { groupMessageId }),
      }).catch((err: unknown) => {
        const error = err instanceof Error ? err.message : "ping";
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "spend.ping",
            address: storedAddress,
            status: "error",
            error,
            ...(kind === "daily" ? {} : { kind }),
          }),
        );
      });
      return json(202, { status: "accepted" });
    }
    if (
      (req.method === "GET" && url.pathname === "/daily-roster") ||
      (req.method === "POST" && DAILY_ROSTER_POST.test(url.pathname))
    ) {
      if (
        !bearerMatchesToken(
          config.giftsApiToken,
          req.headers.get("authorization") ?? undefined,
        )
      ) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      if (req.method === "GET") {
        const loadedLive = loadLiveJson();
        if (!loadedLive.ok) {
          return loadedLive.response;
        }
        const imported = await importDocument(loadedLive);
        if (!imported.ok) {
          return rosterStopJson(imported);
        }
        return jsonResponse(200, toDailyRosterJson(imported.doc));
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { error: "Expected a JSON body" });
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse(400, { error: "Expected a JSON body" });
      }
      const objectBody = body as Record<string, unknown>;
      return recipientsGate.run(async () => {
        const loadedLive = loadLiveJson();
        if (!loadedLive.ok) {
          return loadedLive.response;
        }
        const imported = await importDocument(loadedLive);
        if (!imported.ok) {
          return rosterStopJson(imported);
        }
        const address = objectBody.address as string;
        const amountUsd = objectBody.amountUsd as number;
        const run =
          url.pathname === "/daily-roster/comment"
            ? () => gifts.setRosterComment(objectBody.comment as string)
            : url.pathname === "/daily-roster/payments"
              ? () => gifts.setRosterPayments(objectBody.enabled as boolean)
              : url.pathname === "/daily-roster/recipients/update"
                ? () => gifts.updateRosterRecipient(address, amountUsd)
                : url.pathname === "/daily-roster/recipients/delete"
                  ? () => gifts.deleteRosterRecipient(address)
                  : () => gifts.addRosterRecipient(address, amountUsd);
        const result = await callWorker(run);
        if (!result.ok) {
          return rosterStopJson(result);
        }
        return jsonResponse(200, toDailyRosterJson(result.doc));
      });
    }
    if (req.method === "HEAD" && url.pathname === "/") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "GET" && url.pathname === "/") {
      if (config.dashboardPassword === null) {
        return combinedPage();
      }
      if (requireSession(req)) {
        const loadedLive = loadOrError();
        if (!loadedLive.ok) {
          return loadedLive.response;
        }
        const imported = await importDocument(loadedLive);
        if (!imported.ok) {
          return rosterStopHtml(imported);
        }
        return combinedPage({ kind: "editor" });
      }
      return combinedPage({ kind: "login" });
    }

    if (req.method === "GET" && url.pathname === "/login") {
      if (config.dashboardPassword === null) {
        return unconfiguredPage();
      }
      return redirect("/");
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/login" || url.pathname === "/")
    ) {
      if (config.dashboardPassword === null) {
        return unconfiguredPage();
      }
      if (!requireSameOrigin(req)) {
        return new Response("Forbidden", { status: 403 });
      }
      const form = await readForm(req);
      const submitted = form.get("password") ?? "";
      if (!passwordsMatch(config.dashboardPassword, submitted)) {
        return combinedPage({ kind: "login", error: "Invalid password" });
      }
      const value = mintSessionCookie(config.dashboardPassword, sessionNow);
      return redirect("/", {
        "set-cookie": sessionCookieHeader(value, req, SESSION_TTL_SEC),
      });
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      if (config.dashboardPassword !== null && !requireSameOrigin(req)) {
        return new Response("Forbidden", { status: 403 });
      }
      return redirect("/", {
        "set-cookie": sessionCookieHeader(clearSessionCookie(), req, 0),
      });
    }

    if (req.method === "GET" && url.pathname === "/recipients") {
      if (config.dashboardPassword === null) {
        return unconfiguredPage();
      }
      return redirect("/");
    }

    return new Response("Not found", { status: 404 });
  };

  const gate = createPayoutGate();
  const payout = (
    day: string,
    source: TelegramSource,
    onlyAddresses?: string[],
    messageId?: string,
    extras?: {
      bucket?: "moderator" | "welcome";
      recipients?: Recipient[];
      comment?: string;
      groupMessageId?: string;
    },
  ): Promise<{ exitCode: number }> =>
    gate.run(async () => {
      if (source === "catchup") {
        const today = (opts.now ?? (() => new Date()))()
          .toISOString()
          .slice(0, 10);
        if (today !== day) {
          return { exitCode: 0 };
        }
      }
      const moderator = extras?.bucket === "moderator";
      const welcome = extras?.bucket === "welcome";
      const instructed =
        moderator || welcome || typeof extras?.comment === "string";
      if (!instructed) {
        return { exitCode: 0 };
      }
      const groupMessageId = extras?.groupMessageId;
      const liveList: { comment: string; recipients: Recipient[] } = {
        comment: extras?.comment ?? (welcome ? "Welcome" : "21gifts moderator"),
        recipients: extras?.recipients ?? [],
      };
      const runOptions: RunOptions =
        onlyAddresses === undefined
          ? { live, day }
          : messageId === undefined
            ? moderator
              ? {
                  live,
                  day,
                  onlyAddresses,
                  bucket: "moderator",
                  ...(groupMessageId === undefined
                    ? {}
                    : {
                        groupMessageIdByAddress: Object.fromEntries(
                          onlyAddresses.map((address) => [
                            address.toLowerCase(),
                            groupMessageId,
                          ]),
                        ),
                      }),
                }
              : { live, day, onlyAddresses }
            : {
                live,
                day,
                onlyAddresses,
                messageIdByAddress: Object.fromEntries(
                  onlyAddresses.map((address) => [
                    address.toLowerCase(),
                    messageId,
                  ]),
                ),
                ...(welcome ? { bucket: "welcome" as const } : {}),
              };
      const result = await (opts.runDay ?? runDay)(
        {
          ...config,
          recipients: liveList.recipients,
          comment: liveList.comment,
        },
        runOptions,
      );
      const withSummary = result as { exitCode: number; summary?: RunSummary };
      const returnedSummary = withSummary.summary;
      const summary =
        returnedSummary ?? minimalRunSummary(day, live, withSummary.exitCode);
      if (
        live &&
        onlyAddresses !== undefined &&
        onlyAddresses.length > 0 &&
        (source === "ping" || source === "catchup") &&
        returnedSummary?.reason === "insufficient_balance"
      ) {
        const bucket =
          extras?.bucket === "moderator"
            ? "moderator"
            : extras?.bucket === "welcome"
              ? "welcome"
              : "daily";
        for (const address of onlyAddresses) {
          const row: RetryOwed = { address, bucket };
          if (
            (bucket === "daily" || bucket === "welcome") &&
            messageId !== undefined &&
            MESSAGE_ID_RE.test(messageId)
          ) {
            row.messageId = messageId;
          }
          if (
            bucket === "moderator" &&
            extras?.groupMessageId !== undefined &&
            MESSAGE_ID_RE.test(extras.groupMessageId)
          ) {
            row.groupMessageId = extras.groupMessageId;
          }
          if (extras?.recipients !== undefined) {
            const extra = extras.recipients.find(
              (recipient) =>
                recipient.address.toLowerCase() === address.toLowerCase(),
            );
            if (extra !== undefined) {
              row.amountUsd = extra.amountUsd;
              if (typeof extra.comment === "string") {
                row.comment = extra.comment;
              }
            }
          }
          try {
            appendRetryOwed(config.stateDir, day, row);
          } catch (err: unknown) {
            const error = err instanceof Error ? err.message : "enqueue";
            console.warn(
              JSON.stringify({
                ts: new Date().toISOString(),
                event: "spend.retry.enqueue",
                error,
              }),
            );
          }
        }
      }
      if (telegramTarget !== null && notifyLog.allow(source, summary)) {
        const sent = await notifyPayout({
          target: telegramTarget,
          summary,
          source,
          fetchImpl,
        });
        if (sent.ok) notifyLog.remember(source, summary);
      }
      return { exitCode: result.exitCode };
    });

  /**
   * No-op. Payouts are ping-triggered; boot must not pay the roster.
   *
   * @returns `null` without calling `runDay`.
   */
  const startCatchup = async (): Promise<{ exitCode: number } | null> => null;

  /**
   * Same-UTC-day retry of owed `insufficient_balance` addresses when live and the
   * interval is enabled. Midnight scheduler and boot catch-up stay no-ops.
   *
   * @returns Handle whose `stop` clears the interval (no-op when disabled).
   */
  const startRetryCatchup = (): { stop: () => void } => {
    const intervalMs = retryCatchupIntervalMs();
    if (!live || intervalMs <= 0) {
      return { stop: () => undefined };
    }
    let stopped = false;
    let inProgress = false;
    const tick = async (): Promise<void> => {
      if (stopped || inProgress) {
        return;
      }
      inProgress = true;
      try {
        await runRetryTick();
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : "retry";
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "spend.retry",
            error,
          }),
        );
      } finally {
        inProgress = false;
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, intervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  };

  const retryCatchupIntervalMs = (): number => {
    if (
      typeof opts.retryCatchupMs === "number" &&
      Number.isFinite(opts.retryCatchupMs)
    ) {
      return opts.retryCatchupMs;
    }
    const raw = opts.env["RETRY_CATCHUP_MS"];
    if (raw === undefined || raw.trim() === "") {
      return 900_000;
    }
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  };

  const runRetryTick = async (): Promise<void> => {
    const clock = opts.now ?? (() => new Date());
    const day = clock().toISOString().slice(0, 10);
    const owed = loadRetryOwed(config.stateDir, day);
    const rowsByBucket = new Map<RetryOwed["bucket"], StateRow[] | "corrupt">();
    const rowsFor = (bucket: RetryOwed["bucket"]): StateRow[] | undefined => {
      const cached = rowsByBucket.get(bucket);
      if (cached === "corrupt") {
        return undefined;
      }
      if (cached !== undefined) {
        return cached;
      }
      try {
        const loaded =
          bucket === "welcome" || bucket === "moderator"
            ? new DayState(config.stateDir, day, undefined, bucket).load()
            : new DayState(config.stateDir, day).load();
        rowsByBucket.set(bucket, loaded);
        return loaded;
      } catch (err) {
        if (!(err instanceof CorruptStateError)) {
          throw err;
        }
        rowsByBucket.set(bucket, "corrupt");
        return undefined;
      }
    };
    for (const row of owed) {
      try {
        if (
          typeof row.amountUsd !== "number" ||
          !Number.isFinite(row.amountUsd) ||
          row.amountUsd <= 0 ||
          typeof row.comment !== "string"
        ) {
          continue;
        }
        const rows = rowsFor(row.bucket);
        if (rows === undefined) {
          continue;
        }
        const block = dayBlock(rows, row.address);
        if (
          block === "paid" ||
          block === "uncertain" ||
          latestStatus(rows, row.address) === "failed"
        ) {
          continue;
        }
        if (
          row.bucket === "daily" &&
          dayBlock(rows, "*halt*") === "uncertain"
        ) {
          continue;
        }
        const instructed: Recipient = {
          address: row.address,
          amountUsd: row.amountUsd,
          comment: row.comment,
        };
        await payout(
          day,
          "catchup",
          [row.address],
          row.bucket === "moderator" ? undefined : row.messageId,
          {
            recipients: [instructed],
            comment: row.comment,
            ...(row.bucket === "welcome" || row.bucket === "moderator"
              ? { bucket: row.bucket }
              : {}),
            ...(row.groupMessageId === undefined
              ? {}
              : { groupMessageId: row.groupMessageId }),
          },
        );
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : "retry";
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "spend.retry",
            error,
          }),
        );
      }
    }
  };

  return {
    fetch: fetchHandler,
    startScheduler: () => ({ stop: () => undefined }),
    startCatchup,
    startRetryCatchup,
    runPayout: (day: string) => payout(day, "scheduler"),
    drainPayouts: () => gate.run(async () => undefined),
  };
}

/* v8 ignore start */
const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  try {
    const app = createServer({ env: process.env });
    const bind = parseBindAddr(process.env["BIND_ADDR"]);
    const bun = (
      globalThis as {
        Bun?: {
          serve: (opts: {
            hostname: string;
            port: number;
            fetch: (req: Request) => Promise<Response>;
          }) => unknown;
        };
      }
    ).Bun;
    if (bun === undefined) {
      console.error(
        JSON.stringify({
          event: "spend.config",
          error: "Bun.serve is required",
        }),
      );
      process.exit(2);
    }
    bun.serve({
      hostname: bind.hostname,
      port: bind.port,
      fetch: app.fetch,
    });
    const retryCatchup = app.startRetryCatchup();
    const shutdown = (): void => {
      retryCatchup.stop();
      void app.drainPayouts().finally(() => {
        process.exit(0);
      });
      setTimeout(() => {
        process.exit(1);
      }, 55_000).unref();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "spend.listen",
        hostname: bind.hostname,
        port: bind.port,
      }),
    );
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : "boot";
    console.error(JSON.stringify({ event: "spend.config", error }));
    process.exit(2);
  }
}
/* v8 ignore stop */
