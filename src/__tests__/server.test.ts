import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { GiftsApi } from "../gifts-api";
import { LndhubClient, parseLndhubUri } from "../lndhub";
import { appendRetryOwed, loadRetryOwed, retryQueuePath } from "../retry-queue";
import { runDay as executeRunDay } from "../run";
import { createServer, parseBindAddr } from "../server";
import { withRosterApi } from "./roster-api-mock";

const stateDir = mkdtempSync(join(tmpdir(), "spend-server-"));
const seedPath = join(stateDir, "seed.json");
writeFileSync(
  seedPath,
  `${JSON.stringify({
    comment: "21gifts daily",
    recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
    moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
  })}\n`,
);

const env = {
  GIFTS_API_URL: "http://api.example",
  GIFTS_API_TOKEN: "tok",
  LNDHUB_URI: "lndhub://admin:secret@https://lightning.space/lndhub",
  RECIPIENTS_FILE: seedPath,
  STATE_DIR: stateDir,
};

const sessionDirs: string[] = [];

function req(url: string, init?: RequestInit): Request {
  const parsed = new URL(url);
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) {
    headers.set("host", parsed.host);
  }
  if ((init?.method ?? "GET") === "POST" && !headers.has("origin")) {
    headers.set("origin", parsed.origin);
  }
  return new Request(url, { ...init, headers });
}

/** `POST /ping` without Origin — the route is api-to-api and must not require it. */
function pingReq(init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) {
    headers.set("host", "127.0.0.1");
  }
  return new Request("http://127.0.0.1/ping", {
    ...init,
    method: "POST",
    headers,
  });
}

/** Daily-roster JSON API without Origin — Bearer routes must not require it. */
function dailyRosterReq(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) {
    headers.set("host", "127.0.0.1");
  }
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

const PING_MESSAGE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_MESSAGE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PING_COMMENT = "instructed memo";
const INSTRUCTION_ERROR = {
  error: "Expected a JSON body with address, amountUsd, and comment",
};

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  for (const dir of sessionDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseBindAddr", () => {
  it("parses host and port", () => {
    expect(parseBindAddr("0.0.0.0:3000")).toEqual({
      hostname: "0.0.0.0",
      port: 3000,
    });
  });

  it("defaults when unset, empty, or malformed", () => {
    expect(parseBindAddr(undefined)).toEqual({
      hostname: "0.0.0.0",
      port: 3000,
    });
    expect(parseBindAddr("")).toEqual({ hostname: "0.0.0.0", port: 3000 });
    expect(parseBindAddr("nope")).toEqual({ hostname: "0.0.0.0", port: 3000 });
    expect(parseBindAddr(":80")).toEqual({ hostname: "0.0.0.0", port: 3000 });
    expect(parseBindAddr("host:")).toEqual({ hostname: "0.0.0.0", port: 3000 });
    expect(parseBindAddr("host:99999")).toEqual({
      hostname: "0.0.0.0",
      port: 3000,
    });
  });
});

describe("createServer", () => {
  it("returns 404 for other paths without LNDHub I/O", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/nope"));
    expect(res.status).toBe(404);
  });

  it("serves healthz without LNDHub I/O", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("spend");
  });

  it("HEAD /healthz is 200 with empty body and no fetch", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/healthz", { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("renders sats on GET / without password and has no Log in", async () => {
    const app = createServer({
      env: { ...env, SPEND_LIGHTNING_ADDRESS: "9643e3@lightning.space" },
      fetchImpl: async (url) => {
        const path = String(url);
        if (path.endsWith("/auth")) {
          return new Response(JSON.stringify({ access_token: "tok" }), {
            status: 200,
          });
        }
        if (path.endsWith("/balance")) {
          return new Response(
            JSON.stringify({ BTC: { AvailableBalance: 3803 } }),
            { status: 200 },
          );
        }
        if (path.includes("coinbase.com")) {
          return new Response(
            JSON.stringify({ data: { amount: "78883.06" } }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 404 });
      },
    });
    const res = await app.fetch(req("http://127.0.0.1/"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("3803 sats");
    expect(html).toContain(`${((3803 / 1e8) * 78883.06).toFixed(2)} USD`);
    expect(html).toContain("9643e3@lightning.space");
    expect(html).toContain("Lightning address");
    expect(html).toContain("<svg");
    expect(html).not.toContain("bc1q");
    expect(html).not.toContain("Deposit address");
    expect(html).not.toContain("/getbtc");
    expect(html).not.toContain("/login");
    expect(html).not.toContain("/recipients");
    expect(html).not.toContain("Log in");
    expect(html).not.toContain('action="/recipients/payments"');
    expect(html).not.toContain('action="/moderators/payments"');
  });

  it("GET / with password shows the login form", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="password"');
    expect(html).toContain("Log in");
    expect(html).toContain('action="/"');
    expect(html).toContain("unavailable");
    expect(html).not.toContain('action="/recipients/comment"');
    expect(html).not.toContain('name="comment"');
    expect(html).not.toContain("Payment comment");
    expect(html).not.toContain('action="/recipients/payments"');
    expect(html).not.toContain('action="/moderators/payments"');
    expect(html).not.toContain("Daily payments");
  });

  it("HEAD / is 200 with empty body and does not load the dashboard", async () => {
    const app = createServer({
      env: { ...env, SPEND_LIGHTNING_ADDRESS: "9643e3@lightning.space" },
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("startScheduler is a no-op and does not invoke runDay", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const live = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-25T00:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    const liveHandle = live.startScheduler();
    await Promise.resolve();
    liveHandle.stop();
    const dry = createServer({
      env,
      now: () => new Date("2026-08-25T00:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    const dryHandle = dry.startScheduler();
    await Promise.resolve();
    dryHandle.stop();
    expect(runDay).not.toHaveBeenCalled();
  });

  it("startCatchup always resolves null and does not invoke runDay", async () => {
    const runDay = vi.fn(async () => {
      throw new Error("boom");
    });
    const live = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-27T00:43:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    await expect(live.startCatchup()).resolves.toBeNull();
    const dry = createServer({
      env,
      now: () => new Date("2026-08-27T00:43:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    await expect(dry.startCatchup()).resolves.toBeNull();
    expect(runDay).not.toHaveBeenCalled();
  });

  it("startRetryCatchup is a no-op and does not invoke runDay", async () => {
    vi.useFakeTimers();
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const live = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      retryCatchupMs: 20,
      runDay,
      fetchImpl: withRosterApi(),
    });
    const liveHandle = live.startRetryCatchup();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    liveHandle.stop();
    const dry = createServer({
      env,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      retryCatchupMs: 20,
      runDay,
      fetchImpl: withRosterApi(),
    });
    const dryHandle = dry.startRetryCatchup();
    await vi.advanceTimersByTimeAsync(20);
    dryHandle.stop();
    expect(runDay).not.toHaveBeenCalled();
  });

  it("startRetryCatchup is a no-op and does not invoke runDay when retryCatchupMs is 0 with an owed daily line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-ms-zero-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "alice@walletofsatoshi.com",
      bucket: "daily",
      messageId: PING_MESSAGE_ID,
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 0,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        expect(runDay).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup is a no-op and does not invoke runDay when SPEND_LIVE is unset with an owed daily line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-not-live-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "alice@walletofsatoshi.com",
      bucket: "daily",
      messageId: PING_MESSAGE_ID,
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        expect(runDay).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping enqueues one daily retry row on insufficient_balance and does not write the day JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-ping-enqueue-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: "2026-08-25",
        live: true,
        ok: false,
        exitCode: 3,
        reason: "insufficient_balance",
        needed: 1500,
        available: 10,
        paid: [],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 3,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await app.drainPayouts();
      expect(loadRetryOwed(dir, "2026-08-25")).toEqual([
        {
          address: "alice@walletofsatoshi.com",
          bucket: "daily",
          messageId: PING_MESSAGE_ID,
          amountUsd: 3,
          comment: PING_COMMENT,
        },
      ]);
      expect(existsSync(join(dir, "2026-08-25.jsonl"))).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 400 for an unlisted ping without amountUsd and comment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-ping-unlisted-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: async (url) => {
          if (String(url).includes("/invoices/eligible")) {
            return new Response(
              JSON.stringify({ eligible: true, status: "admitted" }),
              {
                status: 200,
              },
            );
          }
          throw new Error("no network");
        },
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
          }),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
      expect(existsSync(retryQueuePath(dir, "2026-08-25"))).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup pays an unlisted owed daily address once and keeps the retry line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-catchup-unlisted-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "bob@walletofsatoshi.com",
      bucket: "daily",
      messageId: PING_MESSAGE_ID,
      amountUsd: 1,
      comment: PING_COMMENT,
    });
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: "2026-08-25",
        live: true,
        ok: false,
        exitCode: 3,
        reason: "insufficient_balance",
        needed: 1500,
        available: 10,
        paid: [],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        await vi.waitFor(() => expect(runDay).toHaveBeenCalled(), {
          timeout: 2000,
        });
        await app.drainPayouts();
        expect(runDay).toHaveBeenCalledTimes(1);
        expect(runDay).toHaveBeenCalledWith(
          expect.objectContaining({
            comment: PING_COMMENT,
            recipients: [
              {
                address: "bob@walletofsatoshi.com",
                amountUsd: 1,
                comment: PING_COMMENT,
              },
            ],
          }),
          expect.objectContaining({
            onlyAddresses: ["bob@walletofsatoshi.com"],
            messageIdByAddress: {
              "bob@walletofsatoshi.com": PING_MESSAGE_ID,
            },
          }),
        );
        const catchupArgs = runDay.mock.calls[0] as unknown[] | undefined;
        expect(catchupArgs?.[1]).not.toHaveProperty("bucket");
        expect(loadRetryOwed(dir, "2026-08-25")).toEqual([
          {
            address: "bob@walletofsatoshi.com",
            bucket: "daily",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          },
        ]);
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup pays a listed owed daily instruction not the live roster", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-catchup-listed-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "alice@walletofsatoshi.com",
      bucket: "daily",
      messageId: PING_MESSAGE_ID,
      amountUsd: 3,
      comment: PING_COMMENT,
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        await vi.waitFor(() => expect(runDay).toHaveBeenCalled(), {
          timeout: 2000,
        });
        await app.drainPayouts();
        expect(runDay).toHaveBeenCalledWith(
          expect.objectContaining({
            comment: PING_COMMENT,
            recipients: [
              {
                address: "alice@walletofsatoshi.com",
                amountUsd: 3,
                comment: PING_COMMENT,
              },
            ],
          }),
          expect.objectContaining({
            onlyAddresses: ["alice@walletofsatoshi.com"],
            messageIdByAddress: {
              "alice@walletofsatoshi.com": PING_MESSAGE_ID,
            },
          }),
        );
        const catchupArgs = runDay.mock.calls[0] as unknown[] | undefined;
        expect(catchupArgs?.[1]).not.toHaveProperty("bucket");
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup pays a stored daily instruction when paymentsEnabled is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-pay-off-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        paymentsEnabled: false,
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "alice@walletofsatoshi.com",
      bucket: "daily",
      messageId: PING_MESSAGE_ID,
      amountUsd: 3,
      comment: PING_COMMENT,
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        await vi.waitFor(() => expect(runDay).toHaveBeenCalled(), {
          timeout: 2000,
        });
        await app.drainPayouts();
        expect(runDay).toHaveBeenCalledWith(
          expect.objectContaining({
            comment: PING_COMMENT,
            recipients: [
              {
                address: "alice@walletofsatoshi.com",
                amountUsd: 3,
                comment: PING_COMMENT,
              },
            ],
          }),
          expect.objectContaining({
            onlyAddresses: ["alice@walletofsatoshi.com"],
          }),
        );
        expect(loadRetryOwed(dir, "2026-08-25")).toEqual([
          {
            address: "alice@walletofsatoshi.com",
            bucket: "daily",
            messageId: PING_MESSAGE_ID,
            amountUsd: 3,
            comment: PING_COMMENT,
          },
        ]);
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup leaves a daily row unpaid when comment or amountUsd is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-incomplete-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "alice@walletofsatoshi.com",
      bucket: "daily",
      messageId: PING_MESSAGE_ID,
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        expect(runDay).not.toHaveBeenCalled();
        expect(loadRetryOwed(dir, "2026-08-25")).toEqual([
          {
            address: "alice@walletofsatoshi.com",
            bucket: "daily",
            messageId: PING_MESSAGE_ID,
          },
        ]);
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup pays an owed moderator at the stored amountUsd and comment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-mod-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "bob@walletofsatoshi.com",
      bucket: "moderator",
      groupMessageId: GROUP_MESSAGE_ID,
      amountUsd: 9,
      comment: "mod memo",
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        await vi.waitFor(() => expect(runDay).toHaveBeenCalled(), {
          timeout: 2000,
        });
        await app.drainPayouts();
        expect(runDay).toHaveBeenCalledWith(
          expect.objectContaining({
            recipients: [
              {
                address: "bob@walletofsatoshi.com",
                amountUsd: 9,
                comment: "mod memo",
              },
            ],
            comment: "mod memo",
          }),
          expect.objectContaining({
            onlyAddresses: ["bob@walletofsatoshi.com"],
            bucket: "moderator",
            groupMessageIdByAddress: {
              "bob@walletofsatoshi.com": GROUP_MESSAGE_ID,
            },
          }),
        );
        const catchupArgs = runDay.mock.calls[0] as unknown[] | undefined;
        expect(catchupArgs?.[1]).not.toHaveProperty("messageIdByAddress");
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup pays a stored moderator instruction when moderatorPaymentsEnabled is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-mod-off-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        moderatorPaymentsEnabled: false,
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "carol@walletofsatoshi.com",
      bucket: "moderator",
      groupMessageId: GROUP_MESSAGE_ID,
      amountUsd: 9,
      comment: "mod memo",
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        await vi.waitFor(() => expect(runDay).toHaveBeenCalled(), {
          timeout: 2000,
        });
        await app.drainPayouts();
        expect(runDay).toHaveBeenCalledWith(
          expect.objectContaining({
            comment: "mod memo",
            recipients: [
              {
                address: "carol@walletofsatoshi.com",
                amountUsd: 9,
                comment: "mod memo",
              },
            ],
          }),
          expect.objectContaining({
            onlyAddresses: ["carol@walletofsatoshi.com"],
            bucket: "moderator",
          }),
        );
        expect(loadRetryOwed(dir, "2026-08-25")).toEqual([
          {
            address: "carol@walletofsatoshi.com",
            bucket: "moderator",
            groupMessageId: GROUP_MESSAGE_ID,
            amountUsd: 9,
            comment: "mod memo",
          },
        ]);
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup does not invoke runDay when the owed daily address is already paid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-paid-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "alice@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "h",
        status: "paid",
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "alice@walletofsatoshi.com",
      bucket: "daily",
      messageId: PING_MESSAGE_ID,
      amountUsd: 3,
      comment: PING_COMMENT,
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        expect(runDay).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup does not invoke runDay for a previous UTC day retry file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-prev-day-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-27", {
      address: "alice@walletofsatoshi.com",
      bucket: "daily",
      messageId: PING_MESSAGE_ID,
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-28T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        expect(runDay).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping does not enqueue a retry file when SPEND_LIVE is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-ping-dry-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: "2026-08-25",
        live: true,
        ok: false,
        exitCode: 3,
        reason: "insufficient_balance",
        needed: 1500,
        available: 10,
        paid: [],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 3,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await app.drainPayouts();
      expect(existsSync(retryQueuePath(dir, "2026-08-25"))).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on boot when only one Telegram env is set", () => {
    expect(() =>
      createServer({
        env: {
          ...env,
          TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        },
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      }),
    ).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it("startScheduler does not notify Telegram", async () => {
    const telegramCalls: string[] = [];
    const runDay = vi.fn(async () => ({
      exitCode: 0,
      summary: {
        day: "2026-08-25",
        live: true,
        ok: true,
        exitCode: 0,
        paid: [
          {
            address: "alice@walletofsatoshi.com",
            amountSats: 1000,
            amountUsd: 1,
          },
        ],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const app = createServer({
      env: {
        ...env,
        SPEND_LIVE: "true",
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      now: () => new Date("2026-08-25T00:00:00.000Z"),
      runDay,
      fetchImpl: async (url) => {
        if (String(url).includes("api.telegram.org")) {
          telegramCalls.push(String(url));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    const handle = app.startScheduler();
    await Promise.resolve();
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramCalls).toEqual([]);
    handle.stop();
  });

  it("startCatchup does not notify Telegram", async () => {
    const telegramCalls: string[] = [];
    const runDay = vi.fn(async () => ({
      exitCode: 0,
      summary: {
        day: "2026-08-27",
        live: true,
        ok: true,
        exitCode: 0,
        paid: [],
        skipped: [{ address: "alice@walletofsatoshi.com", reason: "paid" }],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const app = createServer({
      env: {
        ...env,
        SPEND_LIVE: "true",
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      now: () => new Date("2026-08-27T00:43:00.000Z"),
      runDay,
      fetchImpl: async (url) => {
        if (String(url).includes("api.telegram.org")) {
          telegramCalls.push(String(url));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    await expect(app.startCatchup()).resolves.toBeNull();
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramCalls).toEqual([]);
  });

  it("POST /ping is 401 without Bearer or with a wrong Bearer", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const missing = await app.fetch(
      pingReq({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
        }),
      }),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Unauthorized" });
    const wrong = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer nope",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
        }),
      }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "Unauthorized" });
  });

  it("POST /ping is 400 for bad JSON or a missing address", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const badJson = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: "not-json",
      }),
    );
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({
      error: "Expected a JSON body with address",
    });
    const missing = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "Expected a JSON body with address",
    });
  });

  it("POST /ping is 400 without messageId", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ address: "alice@walletofsatoshi.com" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Expected a JSON body with address and messageId",
    });
  });

  it("POST /ping is 400 for an invalid messageId", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          messageId: "nope",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Expected a JSON body with address and messageId",
    });
  });

  it("POST /ping is 400 for an invalid address", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "not-an-address",
          messageId: PING_MESSAGE_ID,
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Not a valid Lightning Address (expected name@domain)",
    });
  });

  it("POST /ping is 400 when the address is off the roster and the body has no amountUsd", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env,
      runDay,
      fetchImpl: async (url) => {
        if (String(url).includes("/invoices/eligible")) {
          return new Response(
            JSON.stringify({ eligible: false, status: "none" }),
            { status: 200 },
          );
        }
        throw new Error("no network");
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "bob@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
        }),
      }),
    );
    warn.mockRestore();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INSTRUCTION_ERROR);
    expect(runDay).not.toHaveBeenCalled();
  });

  it("POST /ping is 400 for an unlisted admitted grant without amountUsd and comment", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: async (url) => {
        if (String(url).includes("/invoices/eligible")) {
          return new Response(
            JSON.stringify({ eligible: true, status: "admitted" }),
            {
              status: 200,
            },
          );
        }
        throw new Error("no network");
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "bob@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INSTRUCTION_ERROR);
    expect(runDay).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("POST /ping is 400 for an unlisted trial grant without amountUsd and comment", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: async (url) => {
        if (String(url).includes("/invoices/eligible")) {
          return new Response(
            JSON.stringify({ eligible: true, status: "trial" }),
            { status: 200 },
          );
        }
        throw new Error("no network");
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "bob@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INSTRUCTION_ERROR);
    expect(runDay).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("POST /ping is 400 for unlisted pending, none, or rejected grant without amountUsd", async () => {
    for (const status of ["pending", "none", "rejected"] as const) {
      const runDay = vi.fn(async () => ({ exitCode: 0 }));
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const app = createServer({
        env,
        runDay,
        fetchImpl: async (url) => {
          if (String(url).includes("/invoices/eligible")) {
            return new Response(JSON.stringify({ eligible: false, status }), {
              status: 200,
            });
          }
          throw new Error("no network");
        },
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
          }),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
      warn.mockRestore();
    }
  });

  it("POST /ping is 400 when the unlisted grant lookup would have been needed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-eligible-unreach-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: async (url) => {
          if (String(url).includes("/invoices/eligible")) {
            throw new Error("offline");
          }
          throw new Error("no network");
        },
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "nobody@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
          }),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
      expect(existsSync(join(dir, "2026-08-25.jsonl"))).toBe(false);
      expect(existsSync(join(dir, "2026-08-25.finished"))).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 200 skipped paid for an unlisted admitted grant already paid today", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-unlisted-paid-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "paid",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: async (url) => {
          if (String(url).includes("/invoices/eligible")) {
            return new Response(
              JSON.stringify({ eligible: true, status: "admitted" }),
              {
                status: 200,
              },
            );
          }
          throw new Error("no network");
        },
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 4.5,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "paid" });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 200 skipped failed for an unlisted admitted grant already failed today", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-unlisted-failed-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "failed",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: async (url) => {
          if (String(url).includes("/invoices/eligible")) {
            return new Response(
              JSON.stringify({ eligible: true, status: "trial" }),
              {
                status: 200,
              },
            );
          }
          throw new Error("no network");
        },
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 4.5,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "failed" });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 200 skipped uncertain for an unlisted admitted grant with own uncertain row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-unlisted-uncertain-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "uncertain",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: async (url) => {
          if (String(url).includes("/invoices/eligible")) {
            return new Response(
              JSON.stringify({ eligible: true, status: "admitted" }),
              {
                status: 200,
              },
            );
          }
          throw new Error("no network");
        },
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 4.5,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "skipped",
        reason: "uncertain",
      });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 400 for an unlisted admitted grant without amountUsd while payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-unlisted-pay-off-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        paymentsEnabled: false,
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: async (url) => {
          if (String(url).includes("/invoices/eligible")) {
            return new Response(
              JSON.stringify({ eligible: true, status: "admitted" }),
              {
                status: 200,
              },
            );
          }
          throw new Error("no network");
        },
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
          }),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 200 skipped paid when today JSONL already has a paid row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-paid-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "alice@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "paid",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "paid" });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 202 when another live recipient is uncertain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-uncertain-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [
          { address: "alice@walletofsatoshi.com", amountUsd: 1 },
          { address: "bob@walletofsatoshi.com", amountUsd: 1 },
        ],
      })}\n`,
    );
    writeFileSync(join(dir, "recipients.json"), readFileSync(seed, "utf8"));
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "uncertain",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalled();
      });
      expect(runDay).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: PING_COMMENT,
          recipients: [
            {
              address: "alice@walletofsatoshi.com",
              amountUsd: 1,
              comment: PING_COMMENT,
            },
          ],
        }),
        expect.objectContaining({
          onlyAddresses: ["alice@walletofsatoshi.com"],
        }),
      );
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 202 accepted and queues runDay with onlyAddresses without Origin", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
          amountUsd: 1,
          comment: PING_COMMENT,
        }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalled();
    });
    expect(runDay).toHaveBeenCalledWith(
      expect.objectContaining({
        comment: PING_COMMENT,
        recipients: [
          {
            address: "alice@walletofsatoshi.com",
            amountUsd: 1,
            comment: PING_COMMENT,
          },
        ],
      }),
      expect.objectContaining({
        live: true,
        day: "2026-08-25",
        onlyAddresses: ["alice@walletofsatoshi.com"],
        messageIdByAddress: {
          "alice@walletofsatoshi.com": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        },
      }),
    );
    await app.drainPayouts();
    warn.mockRestore();
  });

  it("POST /ping kind moderator is 202 and queues the instructed amountUsd without messageIdByAddress", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "bob@walletofsatoshi.com",
          kind: "moderator",
          amountUsd: 9,
          comment: "mod memo",
        }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalled();
    });
    expect(runDay).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [
          {
            address: "bob@walletofsatoshi.com",
            amountUsd: 9,
            comment: "mod memo",
          },
        ],
        comment: "mod memo",
      }),
      expect.objectContaining({
        live: true,
        day: "2026-08-25",
        onlyAddresses: ["bob@walletofsatoshi.com"],
        bucket: "moderator",
      }),
    );
    const pingArgs = runDay.mock.calls[0] as unknown[] | undefined;
    expect(pingArgs?.[1]).not.toHaveProperty("messageIdByAddress");
    expect(pingArgs?.[1]).not.toHaveProperty("groupMessageIdByAddress");
    await app.drainPayouts();
    const pingLogs = warn.mock.calls
      .map((args) => String(args[0] ?? ""))
      .filter((line) => line.includes('"event":"spend.ping"'));
    expect(
      pingLogs.some(
        (line) =>
          line.includes('"kind":"moderator"') &&
          line.includes('"status":"accepted"'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it("POST /ping kind moderator with groupMessageId is 202 and queues groupMessageIdByAddress", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "bob@walletofsatoshi.com",
          kind: "moderator",
          groupMessageId: GROUP_MESSAGE_ID,
          amountUsd: 9,
          comment: "mod memo",
        }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalled();
    });
    expect(runDay).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [
          {
            address: "bob@walletofsatoshi.com",
            amountUsd: 9,
            comment: "mod memo",
          },
        ],
        comment: "mod memo",
      }),
      expect.objectContaining({
        live: true,
        day: "2026-08-25",
        onlyAddresses: ["bob@walletofsatoshi.com"],
        bucket: "moderator",
        groupMessageIdByAddress: {
          "bob@walletofsatoshi.com": GROUP_MESSAGE_ID,
        },
      }),
    );
    const pingArgs = runDay.mock.calls[0] as unknown[] | undefined;
    expect(pingArgs?.[1]).not.toHaveProperty("messageIdByAddress");
    await app.drainPayouts();
    warn.mockRestore();
  });

  it("POST /ping kind moderator enqueues one retry row on insufficient_balance with amountUsd and comment and does not write the moderator JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-ping-mod-enqueue-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: "2026-08-25",
        live: true,
        ok: false,
        exitCode: 3,
        reason: "insufficient_balance",
        needed: 1500,
        available: 10,
        paid: [],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
            groupMessageId: GROUP_MESSAGE_ID,
            amountUsd: 9,
            comment: "mod memo",
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await app.drainPayouts();
      expect(loadRetryOwed(dir, "2026-08-25")).toEqual([
        {
          address: "bob@walletofsatoshi.com",
          bucket: "moderator",
          groupMessageId: GROUP_MESSAGE_ID,
          amountUsd: 9,
          comment: "mod memo",
        },
      ]);
      expect(existsSync(join(dir, "2026-08-25.moderator.jsonl"))).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind welcome enqueues one retry row on insufficient_balance and does not write welcome.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-ping-welcome-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: "2026-08-25",
        live: true,
        ok: false,
        exitCode: 3,
        reason: "insufficient_balance",
        needed: 1500,
        available: 10,
        paid: [],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "carol@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            kind: "welcome",
            amountUsd: 2.25,
            comment: "hello there",
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await app.drainPayouts();
      expect(loadRetryOwed(dir, "2026-08-25")).toEqual([
        {
          address: "carol@walletofsatoshi.com",
          bucket: "welcome",
          messageId: PING_MESSAGE_ID,
          amountUsd: 2.25,
          comment: "hello there",
        },
      ]);
      expect(existsSync(join(dir, "welcome.jsonl"))).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup does not pay an owed row after the UTC day rolls while it waits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-midnight-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "alice@walletofsatoshi.com",
      bucket: "daily",
      messageId: PING_MESSAGE_ID,
      amountUsd: 3,
      comment: PING_COMMENT,
    });
    let calls = 0;
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => {
          calls += 1;
          return new Date(
            calls === 1
              ? "2026-08-25T23:59:00.000Z"
              : "2026-08-26T00:00:01.000Z",
          );
        },
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        await app.drainPayouts();
        expect(runDay).not.toHaveBeenCalled();
        expect(loadRetryOwed(dir, "2026-08-25")).toEqual([
          {
            address: "alice@walletofsatoshi.com",
            bucket: "daily",
            messageId: PING_MESSAGE_ID,
            amountUsd: 3,
            comment: PING_COMMENT,
          },
        ]);
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startRetryCatchup pays an owed welcome gift at the stored amount and comment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-retry-welcome-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 4.5 }],
      })}\n`,
    );
    appendRetryOwed(dir, "2026-08-25", {
      address: "carol@walletofsatoshi.com",
      bucket: "welcome",
      messageId: PING_MESSAGE_ID,
      amountUsd: 2.25,
      comment: "hello there",
    });
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        retryCatchupMs: 60_000,
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const { stop } = app.startRetryCatchup();
      try {
        await vi.waitFor(() => expect(runDay).toHaveBeenCalled(), {
          timeout: 2000,
        });
        await app.drainPayouts();
        expect(runDay).toHaveBeenCalledWith(
          expect.objectContaining({
            recipients: [
              {
                address: "carol@walletofsatoshi.com",
                amountUsd: 2.25,
                comment: "hello there",
              },
            ],
            comment: "hello there",
          }),
          expect.objectContaining({
            onlyAddresses: ["carol@walletofsatoshi.com"],
            bucket: "welcome",
            messageIdByAddress: {
              "carol@walletofsatoshi.com": PING_MESSAGE_ID,
            },
          }),
        );
      } finally {
        stop();
      }
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator skips only the moderator JSONL and is independent of the daily file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-mod-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "paid",
      })}\n`,
    );
    const paidRow = (address: string): string =>
      `${JSON.stringify({
        ts: "t",
        address,
        invoiceId: "1",
        paymentHash: "",
        status: "paid",
      })}\n`;
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      const moderatorPing = (): Promise<Response> =>
        app.fetch(
          pingReq({
            headers: {
              authorization: "Bearer tok",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              address: "bob@walletofsatoshi.com",
              kind: "moderator",
              amountUsd: 9,
              comment: "mod memo",
            }),
          }),
        );
      const first = await moderatorPing();
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalledTimes(1);
      });
      writeFileSync(
        join(dir, "2026-08-25.moderator.jsonl"),
        paidRow("bob@walletofsatoshi.com"),
      );
      const skipped = await moderatorPing();
      expect(skipped.status).toBe(200);
      expect(await skipped.json()).toEqual({
        status: "skipped",
        reason: "paid",
      });
      expect(runDay).toHaveBeenCalledTimes(1);
      const dailyAlice = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(dailyAlice.status).toBe(202);
      expect(await dailyAlice.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalledTimes(2);
      });
      writeFileSync(
        join(dir, "2026-08-25.moderator.jsonl"),
        `${paidRow("bob@walletofsatoshi.com")}${paidRow("alice@walletofsatoshi.com")}`,
      );
      const dailyAliceAgain = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(dailyAliceAgain.status).toBe(202);
      expect(await dailyAliceAgain.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalledTimes(3);
      });
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator does not skip on another address uncertain or *halt*", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-mod-halt-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.moderator.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "alice@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "uncertain",
      })}\n${JSON.stringify({
        ts: "t",
        address: "*halt*",
        invoiceId: "",
        paymentHash: "",
        status: "uncertain",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
            amountUsd: 9,
            comment: "mod memo",
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalled();
      });
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator skips own-address uncertain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-mod-uncertain-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.moderator.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "uncertain",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
            amountUsd: 9,
            comment: "mod memo",
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "skipped",
        reason: "uncertain",
      });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator skips paid case-insensitively using the persisted address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-mod-case-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.moderator.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "Bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "paid",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
            amountUsd: 9,
            comment: "mod memo",
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "paid" });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator is 400 when the address is only on the daily roster and amountUsd is missing", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          kind: "moderator",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INSTRUCTION_ERROR);
    expect(runDay).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("POST /ping kind moderator pays the instructed amount without reading the roster", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-mod-roster-case-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "Bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
            amountUsd: 9,
            comment: "mod memo",
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalled();
      });
      expect(runDay).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: "mod memo",
          recipients: [
            {
              address: "bob@walletofsatoshi.com",
              amountUsd: 9,
              comment: "mod memo",
            },
          ],
        }),
        expect.objectContaining({
          onlyAddresses: ["bob@walletofsatoshi.com"],
          bucket: "moderator",
        }),
      );
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator uses the persisted JSONL address over the roster-stored address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-mod-persisted-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.moderator.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "Bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "dry-run",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "BOB@walletofsatoshi.com",
            kind: "moderator",
            amountUsd: 9,
            comment: "mod memo",
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalled();
      });
      expect(runDay).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: "mod memo",
          recipients: [
            {
              address: "Bob@walletofsatoshi.com",
              amountUsd: 9,
              comment: "mod memo",
            },
          ],
        }),
        expect.objectContaining({
          onlyAddresses: ["Bob@walletofsatoshi.com"],
          bucket: "moderator",
        }),
      );
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator is 400 when amountUsd is missing even if the live file is unreadable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-mod-corrupt-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      writeFileSync(join(dir, "recipients.json"), "{");
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
          }),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator is 400 when messageId is present", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          kind: "moderator",
          messageId: PING_MESSAGE_ID,
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Expected a JSON body with address and kind",
    });
  });

  it("POST /ping kind moderator is 400 for a malformed groupMessageId", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const invalid = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "bob@walletofsatoshi.com",
          kind: "moderator",
          groupMessageId: "nope",
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Expected a JSON body with address and kind",
    });
    const notString = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "bob@walletofsatoshi.com",
          kind: "moderator",
          groupMessageId: 1,
        }),
      }),
    );
    expect(notString.status).toBe(400);
    expect(await notString.json()).toEqual({
      error: "Expected a JSON body with address and kind",
    });
  });

  it("POST /ping daily ignores a stray groupMessageId", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    const omittedKind = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
          groupMessageId: GROUP_MESSAGE_ID,
          amountUsd: 1,
          comment: PING_COMMENT,
        }),
      }),
    );
    expect(omittedKind.status).toBe(202);
    expect(await omittedKind.json()).toEqual({ status: "accepted" });
    const dailyKind = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          kind: "daily",
          messageId: PING_MESSAGE_ID,
          groupMessageId: "nope",
          amountUsd: 1,
          comment: PING_COMMENT,
        }),
      }),
    );
    expect(dailyKind.status).toBe(202);
    expect(await dailyKind.json()).toEqual({ status: "accepted" });
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalledTimes(2);
    });
    expect(runDay).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        comment: PING_COMMENT,
        recipients: [
          {
            address: "alice@walletofsatoshi.com",
            amountUsd: 1,
            comment: PING_COMMENT,
          },
        ],
      }),
      expect.objectContaining({
        live: true,
        day: "2026-08-25",
        onlyAddresses: ["alice@walletofsatoshi.com"],
        messageIdByAddress: {
          "alice@walletofsatoshi.com": PING_MESSAGE_ID,
        },
      }),
    );
    expect(runDay).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        comment: PING_COMMENT,
        recipients: [
          {
            address: "alice@walletofsatoshi.com",
            amountUsd: 1,
            comment: PING_COMMENT,
          },
        ],
      }),
      expect.objectContaining({
        live: true,
        day: "2026-08-25",
        onlyAddresses: ["alice@walletofsatoshi.com"],
        messageIdByAddress: {
          "alice@walletofsatoshi.com": PING_MESSAGE_ID,
        },
      }),
    );
    const firstArgs = runDay.mock.calls[0] as unknown[] | undefined;
    const secondArgs = runDay.mock.calls[1] as unknown[] | undefined;
    expect(firstArgs?.[1]).not.toHaveProperty("groupMessageIdByAddress");
    expect(secondArgs?.[1]).not.toHaveProperty("groupMessageIdByAddress");
    await app.drainPayouts();
    warn.mockRestore();
  });

  it("POST /ping welcome is 400 without amountUsd and comment", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "nobody@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
          kind: "welcome",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INSTRUCTION_ERROR);
    expect(runDay).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("POST /ping welcome is 200 skipped paid when welcome.jsonl already has paid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-welcome-paid-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "welcome.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "nobody@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "paid",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "nobody@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            kind: "welcome",
            amountUsd: 2.25,
            comment: "hello there",
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "paid" });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping welcome is 400 without messageId", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          kind: "welcome",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Expected a JSON body with address and messageId",
    });
  });

  it("POST /ping is 400 for an invalid kind", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          kind: "nope",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Expected a JSON body with address and kind",
    });
  });

  it("POST /ping is 400 when paymentsEnabled is false and amountUsd is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-pay-off-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        paymentsEnabled: false,
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      const daily = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
          }),
        }),
      );
      expect(daily.status).toBe(400);
      expect(await daily.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
      const moderator = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
          }),
        }),
      );
      expect(moderator.status).toBe(400);
      expect(await moderator.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator is 400 when moderatorPaymentsEnabled is false and amountUsd is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-mod-off-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        moderatorPaymentsEnabled: false,
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(),
      });
      const moderator = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
          }),
        }),
      );
      expect(moderator.status).toBe(400);
      expect(await moderator.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
      const daily = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
          }),
        }),
      );
      expect(daily.status).toBe(400);
      expect(await daily.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 400 without amountUsd while payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-off-listed-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        paymentsEnabled: false,
        moderatorPaymentsEnabled: false,
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: async (url) => {
          if (String(url).includes("/invoices/eligible")) {
            return new Response(
              JSON.stringify({ eligible: false, status: "none" }),
              {
                status: 200,
              },
            );
          }
          throw new Error("no network");
        },
      });
      const daily = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "nobody@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
          }),
        }),
      );
      expect(daily.status).toBe(400);
      expect(await daily.json()).toEqual(INSTRUCTION_ERROR);
      const moderator = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "nobody@walletofsatoshi.com",
            kind: "moderator",
          }),
        }),
      );
      expect(moderator.status).toBe(400);
      expect(await moderator.json()).toEqual(INSTRUCTION_ERROR);
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping stays paid while payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-off-paid-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        paymentsEnabled: false,
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "alice@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "paid",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "paid" });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping is 202 when another recipient is uncertain and payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-off-uncertain-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [
          { address: "alice@walletofsatoshi.com", amountUsd: 1 },
          { address: "bob@walletofsatoshi.com", amountUsd: 1 },
        ],
        paymentsEnabled: false,
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "uncertain",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalled();
      });
      expect(runDay).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: PING_COMMENT,
          recipients: [
            {
              address: "alice@walletofsatoshi.com",
              amountUsd: 1,
              comment: PING_COMMENT,
            },
          ],
        }),
        expect.objectContaining({
          onlyAddresses: ["alice@walletofsatoshi.com"],
          messageIdByAddress: {
            "alice@walletofsatoshi.com": PING_MESSAGE_ID,
          },
        }),
      );
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping stays failed while daily payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-off-failed-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        paymentsEnabled: false,
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "alice@walletofsatoshi.com",
        invoiceId: "",
        paymentHash: "",
        status: "failed",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "failed" });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator stays paid while moderator payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-off-mod-paid-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        moderatorPaymentsEnabled: false,
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.moderator.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "paid",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
            amountUsd: 9,
            comment: "mod memo",
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "paid" });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator stays uncertain while moderator payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-off-mod-uncertain-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        moderatorPaymentsEnabled: false,
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.moderator.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "uncertain",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
            amountUsd: 9,
            comment: "mod memo",
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "skipped",
        reason: "uncertain",
      });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping kind moderator stays failed while moderator payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-off-mod-failed-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        moderatorPaymentsEnabled: false,
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.moderator.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "bob@walletofsatoshi.com",
        invoiceId: "",
        paymentHash: "",
        status: "failed",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            kind: "moderator",
            amountUsd: 9,
            comment: "mod memo",
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "failed" });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drainPayouts waits for an in-flight ping payout", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runDay = vi.fn(async () => {
      await blocked;
      return { exitCode: 0 };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(),
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
          amountUsd: 1,
          comment: PING_COMMENT,
        }),
      }),
    );
    expect(res.status).toBe(202);
    const drained = app.drainPayouts();
    release();
    await expect(drained).resolves.toBeUndefined();
    expect(runDay).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("runPayout notifies with a minimal summary when runDay omits summary", async () => {
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env: {
        ...env,
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes("api.telegram.org")) {
          telegramBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    await expect(app.runPayout("2026-08-28")).resolves.toEqual({ exitCode: 0 });
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(0);
  });

  it("POST /ping with no summary builds the minimal fallback and does not notify", async () => {
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        SPEND_LIVE: "true",
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes("api.telegram.org")) {
          telegramBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
          amountUsd: 1,
          comment: PING_COMMENT,
        }),
      }),
    );
    expect(res.status).toBe(202);
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalled();
    });
    await app.drainPayouts();
    expect(telegramBodies).toHaveLength(0);
    warn.mockRestore();
  });

  it("POST /ping daily records welcome_paid when the API refuses the invoice after a welcome pay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-welcome-day-ping-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      })}\n`,
    );
    const preimage = "11".repeat(32);
    const paymentHash = createHash("sha256")
      .update(Buffer.from(preimage, "hex"))
      .digest("hex");
    const hub = parseLndhubUri(
      "lndhub://admin:secret@https://lightning.space/lndhub",
    );
    if (hub === null) {
      throw new Error("fixture");
    }
    const clock = (): Date => new Date("2026-08-25T12:00:00.000Z");
    let releasePay!: () => void;
    const payHeld = new Promise<void>((resolve) => {
      releasePay = resolve;
    });
    let markPayStarted!: () => void;
    const payStarted = new Promise<void>((resolve) => {
      markPayStarted = resolve;
    });
    let invoice200 = 0;
    let invoice403 = 0;
    let payinvoiceCalls = 0;
    const telegramCalls: string[] = [];
    const logs: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const href = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (href.includes("api.telegram.org")) {
        telegramCalls.push(href);
        return new Response('{"ok":true}', { status: 200 });
      }
      if (href.includes("/invoices/passkey")) {
        return new Response(JSON.stringify({ hasPasskey: true }), {
          status: 200,
        });
      }
      if (href.includes("/invoices/posted")) {
        return new Response(
          JSON.stringify({
            hasPosted: true,
            hasMedia: true,
            messageId: PING_MESSAGE_ID,
            postedAt: "2026-08-25T11:00:00.000Z",
            welcomeHasMedia: true,
            welcomeMessageId: PING_MESSAGE_ID,
          }),
          { status: 200 },
        );
      }
      if (href.includes("/invoices/proof")) {
        return new Response(JSON.stringify({ status: "paid" }), {
          status: 200,
        });
      }
      if (method === "POST" && href.endsWith("/invoices")) {
        if (invoice200 === 0) {
          invoice200 += 1;
          return new Response(
            JSON.stringify({
              id: `inv${invoice200}`,
              pr: "lnbc1",
              paymentHash,
              amountMsat: 1_000_000,
            }),
            { status: 200 },
          );
        }
        invoice403 += 1;
        return new Response(
          JSON.stringify({ error: "Welcome gift already paid" }),
          { status: 403 },
        );
      }
      if (href.endsWith("/auth")) {
        return new Response(JSON.stringify({ access_token: "t" }), {
          status: 200,
        });
      }
      if (href.endsWith("/balance")) {
        return new Response(
          JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }),
          {
            status: 200,
          },
        );
      }
      if (href.endsWith("/payinvoice")) {
        payinvoiceCalls += 1;
        markPayStarted();
        await payHeld;
        return new Response(JSON.stringify({ payment_preimage: preimage }), {
          status: 200,
        });
      }
      throw new Error(`unexpected ${method} ${href}`);
    };
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((line?: unknown) => {
        logs.push(String(line));
      });
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
          TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
          TELEGRAM_CHAT_ID: "-1001234567890",
        },
        now: clock,
        fetchImpl,
        runDay: (config, options) =>
          executeRunDay(config, options, {
            gifts: new GiftsApi(
              config.giftsApiUrl,
              config.giftsApiToken,
              fetchImpl,
            ),
            lndhub: new LndhubClient(hub, fetchImpl),
            now: clock,
            btcUsd: async () => 100_000,
          }),
      });
      const welcome = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            kind: "welcome",
            amountUsd: 1,
            comment: "hello there",
          }),
        }),
      );
      expect(welcome.status).toBe(202);
      expect(await welcome.json()).toEqual({ status: "accepted" });
      await payStarted;
      const daily = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
      expect(daily.status).toBe(202);
      expect(await daily.json()).toEqual({ status: "accepted" });
      releasePay();
      await app.drainPayouts();
      expect(invoice200).toBe(1);
      expect(invoice403).toBe(1);
      expect(payinvoiceCalls).toBe(1);
      expect(existsSync(join(dir, "2026-08-25.jsonl"))).toBe(false);
      const welcomeLog = readFileSync(join(dir, "welcome.jsonl"), "utf8");
      expect(welcomeLog).toContain('"status":"paid"');
      expect(
        logs.some((line) => line.includes('"reason":"welcome_paid"')),
      ).toBe(true);
      expect(telegramCalls).toHaveLength(1);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping with amountUsd pays an unlisted address without the eligible endpoint", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const eligibleCalls: string[] = [];
    const app = createServer({
      env: { ...env, SPEND_LIVE: "true" },
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: async (url) => {
        if (String(url).includes("/invoices/eligible")) {
          eligibleCalls.push(String(url));
          return new Response(
            JSON.stringify({ eligible: false, status: "none" }),
            {
              status: 200,
            },
          );
        }
        throw new Error("no network");
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "nobody@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
          amountUsd: 4.5,
          comment: "exact memo",
        }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalled();
    });
    expect(eligibleCalls).toEqual([]);
    expect(runDay).toHaveBeenCalledWith(
      expect.objectContaining({
        comment: "exact memo",
        recipients: [
          {
            address: "nobody@walletofsatoshi.com",
            amountUsd: 4.5,
            comment: "exact memo",
          },
        ],
      }),
      expect.objectContaining({
        onlyAddresses: ["nobody@walletofsatoshi.com"],
        messageIdByAddress: {
          "nobody@walletofsatoshi.com": PING_MESSAGE_ID,
        },
      }),
    );
    const pingArgs = runDay.mock.calls[0] as unknown[] | undefined;
    expect(pingArgs?.[1]).not.toHaveProperty("bucket");
    await app.drainPayouts();
    warn.mockRestore();
  });

  it("POST /ping with amountUsd pays when paymentsEnabled is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-instruct-pay-off-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        paymentsEnabled: false,
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 3,
            comment: "keep paying",
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalled();
      });
      expect(runDay).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: "keep paying",
          recipients: [
            {
              address: "alice@walletofsatoshi.com",
              amountUsd: 3,
              comment: "keep paying",
            },
          ],
        }),
        expect.objectContaining({
          onlyAddresses: ["alice@walletofsatoshi.com"],
          messageIdByAddress: {
            "alice@walletofsatoshi.com": PING_MESSAGE_ID,
          },
        }),
      );
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping with amountUsd is 400 when amount or comment is unusable", async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      runDay,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const instructionError = {
      error: "Expected a JSON body with address, amountUsd, and comment",
    };
    const missingMessageId = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          amountUsd: 1,
          comment: "x",
        }),
      }),
    );
    expect(missingMessageId.status).toBe(400);
    expect(await missingMessageId.json()).toEqual({
      error: "Expected a JSON body with address and messageId",
    });
    const bodies: unknown[] = [
      {
        address: "alice@walletofsatoshi.com",
        messageId: PING_MESSAGE_ID,
      },
      {
        address: "alice@walletofsatoshi.com",
        messageId: PING_MESSAGE_ID,
        amountUsd: 1,
      },
      {
        address: "alice@walletofsatoshi.com",
        messageId: PING_MESSAGE_ID,
        amountUsd: 1,
        comment: 1,
      },
      {
        address: "alice@walletofsatoshi.com",
        messageId: PING_MESSAGE_ID,
        amountUsd: 1,
        comment: "a".repeat(501),
      },
      {
        address: "alice@walletofsatoshi.com",
        messageId: PING_MESSAGE_ID,
        amountUsd: 0,
        comment: "x",
      },
      {
        address: "alice@walletofsatoshi.com",
        messageId: PING_MESSAGE_ID,
        amountUsd: -1,
        comment: "x",
      },
      {
        address: "alice@walletofsatoshi.com",
        messageId: PING_MESSAGE_ID,
        amountUsd: "1",
        comment: "x",
      },
      {
        address: "alice@walletofsatoshi.com",
        messageId: PING_MESSAGE_ID,
        amountUsd: null,
        comment: "x",
      },
    ];
    for (const body of bodies) {
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(instructionError);
    }
    const accepted = await app.fetch(
      pingReq({
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          messageId: PING_MESSAGE_ID,
          amountUsd: 1,
          comment: "a".repeat(500),
        }),
      }),
    );
    expect(await accepted.json()).not.toEqual(instructionError);
    expect(accepted.status).not.toBe(400);
    await app.drainPayouts();
    warn.mockRestore();
  });

  it("POST /ping welcome with amountUsd pays that amount and comment while payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-instruct-welcome-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        paymentsEnabled: false,
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "nobody@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            kind: "welcome",
            amountUsd: 2.25,
            comment: "hello there",
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalled();
      });
      expect(runDay).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: "hello there",
          recipients: [
            {
              address: "nobody@walletofsatoshi.com",
              amountUsd: 2.25,
              comment: "hello there",
            },
          ],
        }),
        expect.objectContaining({
          bucket: "welcome",
          onlyAddresses: ["nobody@walletofsatoshi.com"],
          messageIdByAddress: { "nobody@walletofsatoshi.com": PING_MESSAGE_ID },
        }),
      );
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping moderator with amountUsd pays an unlisted address while moderator payments are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-instruct-mod-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        moderatorPaymentsEnabled: false,
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const res = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "carol@walletofsatoshi.com",
            kind: "moderator",
            amountUsd: 9,
            comment: "mod memo",
            groupMessageId: GROUP_MESSAGE_ID,
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalled();
      });
      expect(runDay).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: "mod memo",
          recipients: [
            {
              address: "carol@walletofsatoshi.com",
              amountUsd: 9,
              comment: "mod memo",
            },
          ],
        }),
        expect.objectContaining({
          bucket: "moderator",
          onlyAddresses: ["carol@walletofsatoshi.com"],
          groupMessageIdByAddress: {
            "carol@walletofsatoshi.com": GROUP_MESSAGE_ID,
          },
        }),
      );
      const pingArgs = runDay.mock.calls[0] as unknown[] | undefined;
      expect(pingArgs?.[1]).not.toHaveProperty("messageIdByAddress");
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /ping with amountUsd skips paid, ignores another uncertain row, and skips *halt*", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-ping-instruct-idem-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [
          { address: "alice@walletofsatoshi.com", amountUsd: 1 },
          { address: "bob@walletofsatoshi.com", amountUsd: 1 },
        ],
      })}\n`,
    );
    writeFileSync(
      join(dir, "2026-08-25.jsonl"),
      `${JSON.stringify({
        ts: "t",
        address: "alice@walletofsatoshi.com",
        invoiceId: "1",
        paymentHash: "",
        status: "paid",
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: {
          ...env,
          STATE_DIR: dir,
          RECIPIENTS_FILE: seed,
          SPEND_LIVE: "true",
        },
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        runDay,
        fetchImpl: withRosterApi(async () => {
          throw new Error("no network");
        }),
      });
      const paid = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 4,
            comment: "already paid",
          }),
        }),
      );
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ status: "skipped", reason: "paid" });
      expect(runDay).not.toHaveBeenCalled();
      writeFileSync(
        join(dir, "2026-08-25.jsonl"),
        `${JSON.stringify({
          ts: "t",
          address: "bob@walletofsatoshi.com",
          invoiceId: "1",
          paymentHash: "",
          status: "uncertain",
        })}\n`,
      );
      const otherUncertain = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 4,
            comment: "not blocked",
          }),
        }),
      );
      expect(otherUncertain.status).toBe(202);
      expect(await otherUncertain.json()).toEqual({ status: "accepted" });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalledTimes(1);
      });
      writeFileSync(
        join(dir, "2026-08-25.jsonl"),
        `${JSON.stringify({
          ts: "t",
          address: "*halt*",
          invoiceId: "",
          paymentHash: "",
          status: "uncertain",
        })}\n`,
      );
      const halted = await app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "alice@walletofsatoshi.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 4,
            comment: "halted",
          }),
        }),
      );
      expect(halted.status).toBe(200);
      expect(await halted.json()).toEqual({
        status: "skipped",
        reason: "uncertain",
      });
      expect(runDay).toHaveBeenCalledTimes(1);
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function cookieFrom(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

function sessionEnv(): typeof env & { SPEND_DASHBOARD_PASSWORD: string } {
  const dir = mkdtempSync(join(tmpdir(), "spend-sess-"));
  sessionDirs.push(dir);
  const seed = join(dir, "seed.json");
  writeFileSync(
    seed,
    `${JSON.stringify({
      comment: "21gifts daily",
      recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
    })}\n`,
  );
  return {
    ...env,
    STATE_DIR: dir,
    RECIPIENTS_FILE: seed,
    SPEND_DASHBOARD_PASSWORD: "test-password",
  };
}

/** Parsed `STATE_DIR/recipients.json` after an editor mutation. */
type LiveRosterFile = {
  comment: string;
  recipients: Array<{ address: string; amountUsd: number; comment?: string }>;
  moderators: Array<{ address: string; amountUsd: number }>;
  paymentsEnabled?: boolean;
  moderatorPaymentsEnabled?: boolean;
};

/**
 * Read the live roster file from `stateDir`.
 *
 * @param stateDir - `STATE_DIR` used by the server under test.
 * @returns Parsed comment and both roster lists.
 */
function readLiveRoster(stateDir: string): LiveRosterFile {
  return JSON.parse(
    readFileSync(join(stateDir, "recipients.json"), "utf8"),
  ) as LiveRosterFile;
}

function liveFileRaw(stateDir: string): string {
  return readFileSync(join(stateDir, "recipients.json"), "utf8");
}

async function fetchDailyRoster(
  app: ReturnType<typeof createServer>,
): Promise<LiveRosterFile & { defaultAmountUsd: number }> {
  const res = await app.fetch(
    dailyRosterReq("/daily-roster", {
      headers: { authorization: "Bearer tok" },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as LiveRosterFile & { defaultAmountUsd: number };
}

async function login(
  app: ReturnType<typeof createServer>,
  password = "test-password",
): Promise<string> {
  const res = await app.fetch(
    req("http://127.0.0.1/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(password)}`,
    }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  const setCookie = cookieFrom(res);
  const match = /spend_session=([^;]+)/.exec(setCookie);
  return match?.[1] ?? "";
}

describe("recipient editor", () => {
  it("GET /login redirects to / when a password is configured", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/login"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("GET /login is 503 when the password is unset", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/login"));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Recipient editor is not configured");
  });

  it("POST /login is 503 when the password is unset", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "password=x",
      }),
    );
    expect(res.status).toBe(503);
  });

  it("rejects a wrong password without a session cookie", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "password=nope",
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid password");
    expect(html).toContain('name="password"');
    expect(cookieFrom(res)).not.toContain("spend_session=v1.");
  });

  it("logs in from a raw form body without a content-type", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/login", {
        method: "POST",
        body: "password=test-password",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cookieFrom(res)).toContain("spend_session=v1.");
  });

  it("logs in and lists the moderator editor on GET /", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    expect(token.startsWith("v1.")).toBe(true);
    const res = await app.fetch(
      req("http://127.0.0.1/", {
        headers: { cookie: `spend_session=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Log out");
    expect(html).toContain('href="https://21.gifts/grants/payments/comment"');
    expect(html).toContain('href="https://21.gifts/grants/payments/amounts"');
    expect(html).toContain("<h2>Moderators</h2>");
    expect(html).toContain("No moderators");
    expect(html).toContain('aria-label="Moderator payments"');
    expect(html).not.toContain("alice@walletofsatoshi.com");
    expect(html).not.toContain(">21gifts daily</textarea>");
    expect(html).not.toContain("Payment comment");
    expect(html).not.toContain('aria-label="Daily payments"');
    expect(html).not.toContain('action="/recipients/comment"');
    expect(html).not.toContain('action="/recipients/payments"');
    expect(html).not.toContain('action="/recipients/add"');
    expect(html).not.toContain('action="/recipients/update"');
    expect(html).not.toContain('action="/recipients/delete"');
  });

  it("GET /recipients without a cookie redirects to /", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/recipients"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("GET /recipients with a cookie redirects to /", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const res = await app.fetch(
      req("http://127.0.0.1/recipients", {
        headers: { cookie: `spend_session=${token}` },
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("GET /recipients is 503 when the password is unset", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/recipients"));
    expect(res.status).toBe(503);
  });

  it("cookie POST /recipients/add is 404 with no session check", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const crossOrigin = await app.fetch(
      req("http://127.0.0.1/recipients/add", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `spend_session=${token}`,
          origin: "https://evil.example",
        },
        body: "address=bob@walletofsatoshi.com&amountUsd=2",
      }),
    );
    expect(crossOrigin.status).toBe(404);
    const unauthenticated = await app.fetch(
      req("http://127.0.0.1/recipients/add", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "address=bob@walletofsatoshi.com&amountUsd=2",
      }),
    );
    expect(unauthenticated.status).toBe(404);
  });

  it("accepts multipart login and sets Secure when forwarded proto is https", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const form = new FormData();
    form.set("password", "test-password");
    const res = await app.fetch(
      req("https://spend.example/login", {
        method: "POST",
        headers: { "x-forwarded-proto": "https" },
        body: form,
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cookieFrom(res)).toContain("Secure");
  });

  it("POST /logout clears the cookie", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/logout", { method: "POST" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cookieFrom(res)).toContain("Max-Age=0");
  });

  it("GET / is 500 when the live file is corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-bad-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n',
    );
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_DASHBOARD_PASSWORD: "test-password",
      },
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    writeFileSync(join(dir, "recipients.json"), "{");
    const res = await app.fetch(
      req("http://127.0.0.1/", {
        headers: { cookie: `spend_session=${token}` },
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Recipient list is unreadable");
    rmSync(dir, { recursive: true, force: true });
  });

  it("payout reloads the live list and skips a corrupt file", async () => {
    const sess = sessionEnv();
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env: sess,
      runDay,
      fetchImpl: withRosterApi(),
    });
    await app.fetch(
      dailyRosterReq("/daily-roster/recipients", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "bob@walletofsatoshi.com",
          amountUsd: 2,
        }),
      }),
    );
    await expect(app.runPayout("2026-08-28")).resolves.toEqual({ exitCode: 0 });
    expect(runDay).not.toHaveBeenCalled();
    writeFileSync(join(sess.STATE_DIR, "recipients.json"), "not-json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(app.runPayout("2026-08-28")).resolves.toEqual({ exitCode: 0 });
    expect(runDay).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("corrupt_recipients");
    warn.mockRestore();
  });

  it("notifies Telegram on corrupt recipients once; catch-up stays silent after runPayout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-corrupt-tg-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n',
    );
    writeFileSync(join(dir, "recipients.json"), "{");
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: "true",
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes("api.telegram.org")) {
          telegramBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    await expect(app.runPayout("2026-08-28")).resolves.toEqual({ exitCode: 0 });
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(0);

    await expect(app.startCatchup()).resolves.toBeNull();
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(0);
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("startCatchup is a no-op when live recipients are corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-corrupt-tg-cu-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n',
    );
    writeFileSync(join(dir, "recipients.json"), "{");
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: "true",
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes("api.telegram.org")) {
          telegramBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    await expect(app.startCatchup()).resolves.toBeNull();
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(0);
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupes ping insufficient_balance Telegram until a paid run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-tg-dedupe-cu-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n',
    );
    const telegramBodies: unknown[] = [];
    const insufficient = {
      exitCode: 3,
      summary: {
        day: "2026-09-06",
        live: true,
        ok: false,
        exitCode: 3,
        reason: "insufficient_balance",
        needed: 1500,
        available: 10,
        paid: [] as Array<{ address: string; amountSats?: number }>,
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    };
    const runDay = vi
      .fn()
      .mockResolvedValueOnce(insufficient)
      .mockResolvedValueOnce({
        ...insufficient,
        summary: { ...insufficient.summary, needed: 1600, available: 5 },
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        summary: {
          day: "2026-09-06",
          live: true,
          ok: true,
          exitCode: 0,
          paid: [{ address: "a@b.com", amountSats: 1000 }],
          skipped: [],
          failed: [],
          uncertain: [],
          dryRun: [],
        },
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: "true",
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      now: () => new Date("2026-09-06T12:00:00.000Z"),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes("api.telegram.org")) {
          telegramBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    const ping = (): Promise<Response> =>
      app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "a@b.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
    expect((await ping()).status).toBe(202);
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(telegramBodies).toHaveLength(1);
    });
    expect(telegramBodies[0]).toMatchObject({
      text: expect.stringContaining("insufficient_balance"),
    });
    expect((await ping()).status).toBe(202);
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalledTimes(2);
    });
    expect(telegramBodies).toHaveLength(1);
    expect((await ping()).status).toBe(202);
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalledTimes(3);
    });
    await vi.waitFor(() => {
      expect(telegramBodies).toHaveLength(2);
    });
    expect(telegramBodies[1]).toMatchObject({
      text: expect.stringContaining("a@b.com"),
    });
    await app.drainPayouts();
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupes scheduler insufficient_balance Telegram across two runPayout calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-tg-dedupe-sched-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n',
    );
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: "2026-09-06",
        live: true,
        ok: false,
        exitCode: 3,
        reason: "insufficient_balance",
        needed: 1500,
        available: 10,
        paid: [],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: "true",
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes("api.telegram.org")) {
          telegramBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    await expect(app.runPayout("2026-09-06")).resolves.toEqual({ exitCode: 0 });
    await expect(app.runPayout("2026-09-06")).resolves.toEqual({ exitCode: 0 });
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupes ping usd_to_sats Telegram even when failed mirrors the preflight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-tg-dedupe-usd-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n',
    );
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: "2026-09-06",
        live: true,
        ok: false,
        exitCode: 3,
        reason: "usd_to_sats",
        paid: [],
        skipped: [],
        failed: [{ address: "a@b.com" }],
        uncertain: [],
        dryRun: [],
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: "true",
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      now: () => new Date("2026-09-06T12:00:00.000Z"),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes("api.telegram.org")) {
          telegramBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    const ping = (): Promise<Response> =>
      app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "a@b.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
    expect((await ping()).status).toBe(202);
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(telegramBodies).toHaveLength(1);
    });
    expect((await ping()).status).toBe(202);
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalledTimes(2);
    });
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      text: expect.stringContaining("usd_to_sats"),
    });
    await app.drainPayouts();
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("retries Telegram after a failed send; remember only after HTTP ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-tg-remember-fail-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n',
    );
    const telegramOkBodies: unknown[] = [];
    let telegramAttempts = 0;
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: "2026-09-06",
        live: true,
        ok: false,
        exitCode: 3,
        reason: "insufficient_balance",
        needed: 1500,
        available: 10,
        paid: [],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: "true",
        TELEGRAM_BOT_TOKEN: "123456:AA-testtoken_notreal_xxxxxx",
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      now: () => new Date("2026-09-06T12:00:00.000Z"),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes("api.telegram.org")) {
          telegramAttempts += 1;
          if (telegramAttempts === 1) {
            return new Response("fail", { status: 500 });
          }
          telegramOkBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    const ping = (): Promise<Response> =>
      app.fetch(
        pingReq({
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            address: "a@b.com",
            messageId: PING_MESSAGE_ID,
            amountUsd: 1,
            comment: PING_COMMENT,
          }),
        }),
      );
    expect((await ping()).status).toBe(202);
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(telegramAttempts).toBe(1);
    });
    expect(telegramOkBodies).toHaveLength(0);
    expect((await ping()).status).toBe(202);
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(telegramAttempts).toBe(2);
    });
    expect(telegramOkBodies).toHaveLength(1);
    expect(telegramOkBodies[0]).toMatchObject({
      text: expect.stringContaining("insufficient_balance"),
    });
    await app.drainPayouts();
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("cookie POST daily recipient paths are 404 when the password is unset", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    for (const path of [
      "/recipients/add",
      "/recipients/update",
      "/recipients/delete",
      "/recipients/comment",
      "/recipients/payments",
    ]) {
      const res = await app.fetch(
        req(`http://127.0.0.1${path}`, { method: "POST" }),
      );
      expect(res.status).toBe(404);
    }
  });

  it("cookie POST remaining daily recipient paths are 404 with no session check", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const comment = await app.fetch(
      req("http://127.0.0.1/recipients/comment", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "comment=hello+gifts",
      }),
    );
    expect(comment.status).toBe(404);
    const unauthenticated = await app.fetch(
      req("http://127.0.0.1/recipients/comment", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "comment=hello+gifts",
      }),
    );
    expect(unauthenticated.status).toBe(404);
    const headers = new Headers();
    headers.set("host", "127.0.0.1");
    headers.set("content-type", "application/x-www-form-urlencoded");
    headers.set("cookie", `spend_session=${token}`);
    const noOrigin = await app.fetch(
      new Request("http://127.0.0.1/recipients/comment", {
        method: "POST",
        headers,
        body: "comment=hello+gifts",
      }),
    );
    expect(noOrigin.status).toBe(404);
    const update = await app.fetch(
      req("http://127.0.0.1/recipients/update", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=&amountUsd=3",
      }),
    );
    expect(update.status).toBe(404);
    const del = await app.fetch(
      req("http://127.0.0.1/recipients/delete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=",
      }),
    );
    expect(del.status).toBe(404);
  });
});

describe("moderator editor", () => {
  it("adds, updates, and deletes moderators", async () => {
    const sess = sessionEnv();
    const app = createServer({
      env: sess,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const add = await app.fetch(
      req("http://127.0.0.1/moderators/add", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=bob@walletofsatoshi.com&amountUsd=2",
      }),
    );
    const seedRaw = liveFileRaw(sess.STATE_DIR);
    expect(add.status).toBe(303);
    expect(add.headers.get("location")).toBe("/");
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect((await fetchDailyRoster(app)).moderators).toEqual([
      { address: "bob@walletofsatoshi.com", amountUsd: 2 },
    ]);
    const dup = await app.fetch(
      req("http://127.0.0.1/moderators/add", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=bob@walletofsatoshi.com&amountUsd=9",
      }),
    );
    expect(dup.status).toBe(200);
    expect(await dup.text()).toContain("Address already listed");
    const dupCase = await app.fetch(
      req("http://127.0.0.1/moderators/add", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=Bob@WalletOfSatoshi.com&amountUsd=9",
      }),
    );
    expect(dupCase.status).toBe(200);
    expect(await dupCase.text()).toContain("Address already listed");
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect((await fetchDailyRoster(app)).moderators).toEqual([
      { address: "bob@walletofsatoshi.com", amountUsd: 2 },
    ]);
    const badAdd = await app.fetch(
      req("http://127.0.0.1/moderators/add", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=not-an-address&amountUsd=2",
      }),
    );
    expect(await badAdd.text()).toContain("Invalid address or amount");
    const update = await app.fetch(
      req("http://127.0.0.1/moderators/update", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=bob@walletofsatoshi.com&amountUsd=3",
      }),
    );
    expect(update.status).toBe(303);
    expect(update.headers.get("location")).toBe("/");
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect((await fetchDailyRoster(app)).moderators).toEqual([
      { address: "bob@walletofsatoshi.com", amountUsd: 3 },
    ]);
    const unknown = await app.fetch(
      req("http://127.0.0.1/moderators/update", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=nobody@walletofsatoshi.com&amountUsd=3",
      }),
    );
    expect(await unknown.text()).toContain("Unknown address");
    const badUsd = await app.fetch(
      req("http://127.0.0.1/moderators/update", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=bob@walletofsatoshi.com&amountUsd=0",
      }),
    );
    expect(await badUsd.text()).toContain("Invalid address or amount");
    const listed = await app.fetch(
      req("http://127.0.0.1/", { headers: { cookie } }),
    );
    expect(await listed.text()).toContain('value="3"');
    const del = await app.fetch(
      req("http://127.0.0.1/moderators/delete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=bob@walletofsatoshi.com",
      }),
    );
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe("/");
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect((await fetchDailyRoster(app)).moderators).toEqual([]);
    const delUnknown = await app.fetch(
      req("http://127.0.0.1/moderators/delete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=bob@walletofsatoshi.com",
      }),
    );
    expect(await delUnknown.text()).toContain("Unknown address");
    const empty = await app.fetch(
      req("http://127.0.0.1/", { headers: { cookie } }),
    );
    expect(await empty.text()).toContain("No moderators");
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect((await fetchDailyRoster(app)).recipients).toEqual([
      { address: "alice@walletofsatoshi.com", amountUsd: 1 },
    ]);
  });

  it("unauthenticated POST /moderators/add redirects to /", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/add", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "address=bob@walletofsatoshi.com&amountUsd=2",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("rejects a cross-origin moderator mutation", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/add", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `spend_session=${token}`,
          origin: "https://evil.example",
        },
        body: "address=bob@walletofsatoshi.com&amountUsd=2",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("POST /moderators/add is 503 when the password is unset", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/add", { method: "POST" }),
    );
    expect(res.status).toBe(503);
  });

  it("POST /moderators/update with a blank address is unknown", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/update", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `spend_session=${token}`,
        },
        body: "address=&amountUsd=3",
      }),
    );
    expect(await res.text()).toContain("Unknown address");
  });

  it("POST /moderators/delete with a blank address is unknown", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/delete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `spend_session=${token}`,
        },
        body: "address=",
      }),
    );
    expect(await res.text()).toContain("Unknown address");
  });

  it("editing one roster leaves the other list byte-for-byte unchanged", async () => {
    const sess = sessionEnv();
    const recipients = [
      { address: "alice@walletofsatoshi.com", amountUsd: 1 },
      { address: "carol@walletofsatoshi.com", amountUsd: 4 },
    ];
    const moderators = [
      { address: "dana@walletofsatoshi.com", amountUsd: 7.5 },
    ];
    writeFileSync(
      sess.RECIPIENTS_FILE,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients,
        moderators,
      })}\n`,
    );
    const app = createServer({
      env: sess,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const seedRaw = liveFileRaw(sess.STATE_DIR);
    const recipientsBytes = JSON.stringify(recipients);
    const addMod = await app.fetch(
      req("http://127.0.0.1/moderators/add", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=erin@walletofsatoshi.com&amountUsd=2",
      }),
    );
    expect(addMod.status).toBe(303);
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    const afterModAdd = await fetchDailyRoster(app);
    expect(JSON.stringify(afterModAdd.recipients)).toBe(recipientsBytes);
    expect(afterModAdd.moderators).toEqual([
      { address: "dana@walletofsatoshi.com", amountUsd: 7.5 },
      { address: "erin@walletofsatoshi.com", amountUsd: 2 },
    ]);
    const updateMod = await app.fetch(
      req("http://127.0.0.1/moderators/update", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=dana@walletofsatoshi.com&amountUsd=8",
      }),
    );
    expect(updateMod.status).toBe(303);
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect(JSON.stringify((await fetchDailyRoster(app)).recipients)).toBe(
      recipientsBytes,
    );
    const delMod = await app.fetch(
      req("http://127.0.0.1/moderators/delete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "address=erin@walletofsatoshi.com",
      }),
    );
    expect(delMod.status).toBe(303);
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect(JSON.stringify((await fetchDailyRoster(app)).recipients)).toBe(
      recipientsBytes,
    );
    const bearer = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };
    const addRec = await app.fetch(
      dailyRosterReq("/daily-roster/recipients", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({
          address: "frank@walletofsatoshi.com",
          amountUsd: 9,
        }),
      }),
    );
    expect(addRec.status).toBe(200);
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    const afterRecAdd = (await addRec.json()) as LiveRosterFile;
    const moderatorsBytes = JSON.stringify(afterRecAdd.moderators);
    expect(afterRecAdd.recipients).toEqual([
      { address: "alice@walletofsatoshi.com", amountUsd: 1 },
      { address: "carol@walletofsatoshi.com", amountUsd: 4 },
      { address: "frank@walletofsatoshi.com", amountUsd: 9 },
    ]);
    const updateRec = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/update", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({
          address: "carol@walletofsatoshi.com",
          amountUsd: 5,
        }),
      }),
    );
    expect(updateRec.status).toBe(200);
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect(
      JSON.stringify(((await updateRec.json()) as LiveRosterFile).moderators),
    ).toBe(moderatorsBytes);
    const delRec = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/delete", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ address: "frank@walletofsatoshi.com" }),
      }),
    );
    expect(delRec.status).toBe(200);
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect(
      JSON.stringify(((await delRec.json()) as LiveRosterFile).moderators),
    ).toBe(moderatorsBytes);
  });
});

describe("payment switches", () => {
  it("POST /daily-roster/payments persists Off and preserves the other flag and both rosters", async () => {
    const sess = sessionEnv();
    writeFileSync(
      sess.RECIPIENTS_FILE,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    const app = createServer({
      env: sess,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/payments", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    const seedRaw = liveFileRaw(sess.STATE_DIR);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      paymentsEnabled: false,
      comment: "21gifts daily",
      recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      moderatorPaymentsEnabled: true,
    });
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    const token = await login(app);
    const listed = await app.fetch(
      req("http://127.0.0.1/", {
        headers: { cookie: `spend_session=${token}` },
      }),
    );
    const html = await listed.text();
    expect(html).not.toContain('action="/recipients/payments"');
    expect(html).not.toContain("Payment comment");
    expect(html).toContain('action="/moderators/payments"');
  });

  it("POST /moderators/payments persists Off and leaves daily payments unchanged", async () => {
    const sess = sessionEnv();
    writeFileSync(
      sess.RECIPIENTS_FILE,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        paymentsEnabled: false,
        moderatorPaymentsEnabled: true,
      })}\n`,
    );
    const app = createServer({
      env: sess,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/payments", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "enabled=off",
      }),
    );
    const seedRaw = liveFileRaw(sess.STATE_DIR);
    expect(res.status).toBe(303);
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    const live = await fetchDailyRoster(app);
    expect(live.paymentsEnabled).toBe(false);
    expect(live.moderatorPaymentsEnabled).toBe(false);
    expect(live.recipients).toEqual([
      { address: "alice@walletofsatoshi.com", amountUsd: 1 },
    ]);
    expect(live.moderators).toEqual([
      { address: "bob@walletofsatoshi.com", amountUsd: 7.5 },
    ]);
    const on = await app.fetch(
      dailyRosterReq("/daily-roster/payments", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(on.status).toBe(200);
    const afterOn = (await on.json()) as LiveRosterFile;
    expect(afterOn.paymentsEnabled).toBe(true);
    expect(afterOn.moderatorPaymentsEnabled).toBe(false);
  });

  it("rejects an invalid enabled value without writing", async () => {
    const sess = sessionEnv();
    const app = createServer({
      env: sess,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const before = readFileSync(
      join(sess.STATE_DIR, "recipients.json"),
      "utf8",
    );
    for (const body of [
      {},
      { enabled: "off" },
      { enabled: 1 },
      { enabled: "true" },
    ]) {
      const res = await app.fetch(
        dailyRosterReq("/daily-roster/payments", {
          method: "POST",
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid payments switch" });
    }
    const modInvalid = await app.fetch(
      req("http://127.0.0.1/moderators/payments", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "enabled=true",
      }),
    );
    expect(modInvalid.status).toBe(200);
    expect(await modInvalid.text()).toContain("Invalid payments switch");
    expect(readFileSync(join(sess.STATE_DIR, "recipients.json"), "utf8")).toBe(
      before,
    );
  });

  it("daily payments without the bearer token are 401 and the old form is 404", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const form = await app.fetch(
      req("http://127.0.0.1/recipients/payments", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "enabled=off",
      }),
    );
    expect(form.status).toBe(404);
    const json = await app.fetch(
      dailyRosterReq("/daily-roster/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(json.status).toBe(401);
    expect(await json.json()).toEqual({ error: "Unauthorized" });
  });

  it("POST /daily-roster/payments with the wrong bearer is 401", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/payments", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("GET /daily-roster without a bearer is 401", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(dailyRosterReq("/daily-roster"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("GET /daily-roster with the wrong bearer is 401", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("GET /daily-roster with a session cookie and no bearer is 401", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const res = await app.fetch(
      dailyRosterReq("/daily-roster", {
        headers: { cookie: `spend_session=${token}` },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("POST /daily-roster/comment rejects a non-JSON body", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/comment", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Expected a JSON body" });
  });

  it("POST /daily-roster/comment rejects a JSON array and a JSON number", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const bearer = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };
    const arrayBody = await app.fetch(
      dailyRosterReq("/daily-roster/comment", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify([]),
      }),
    );
    expect(arrayBody.status).toBe(400);
    expect(await arrayBody.json()).toEqual({ error: "Expected a JSON body" });
    const numberBody = await app.fetch(
      dailyRosterReq("/daily-roster/comment", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify(1),
      }),
    );
    expect(numberBody.status).toBe(400);
    expect(await numberBody.json()).toEqual({ error: "Expected a JSON body" });
  });

  it("POST /daily-roster/comment rejects a non-string and an overlong comment", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const bearer = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };
    const nonString = await app.fetch(
      dailyRosterReq("/daily-roster/comment", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ comment: 1 }),
      }),
    );
    expect(nonString.status).toBe(400);
    expect(await nonString.json()).toEqual({ error: "Invalid comment" });
    const overlong = await app.fetch(
      dailyRosterReq("/daily-roster/comment", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ comment: "a".repeat(501) }),
      }),
    );
    expect(overlong.status).toBe(400);
    expect(await overlong.json()).toEqual({ error: "Invalid comment" });
  });

  it("POST /daily-roster/comment keeps an empty string", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/comment", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ comment: "" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      comment: "",
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      moderators: [],
      moderatorPaymentsEnabled: true,
    });
  });

  it("POST /daily-roster/comment collapses newlines and trims", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/comment", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ comment: "\n foo\nbar " }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      comment: "foo bar",
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      moderators: [],
      moderatorPaymentsEnabled: true,
    });
  });

  it("POST /daily-roster/recipients does not coerce a numeric amount string", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/recipients", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ address: "new@example.com", amountUsd: "1" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid address or amount" });
  });

  it("POST /daily-roster/recipients rejects a different letter case of a listed address", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/recipients", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "Alice@walletofsatoshi.com",
          amountUsd: 1,
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Address already listed" });
  });

  it("POST /daily-roster/recipients rejects zero and negative amounts", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const bearer = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };
    const zero = await app.fetch(
      dailyRosterReq("/daily-roster/recipients", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ address: "zero@example.com", amountUsd: 0 }),
      }),
    );
    expect(zero.status).toBe(400);
    expect(await zero.json()).toEqual({ error: "Invalid address or amount" });
    const negative = await app.fetch(
      dailyRosterReq("/daily-roster/recipients", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ address: "neg@example.com", amountUsd: -1 }),
      }),
    );
    expect(negative.status).toBe(400);
    expect(await negative.json()).toEqual({
      error: "Invalid address or amount",
    });
  });

  it("POST /daily-roster/recipients/update rejects an unknown address", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/update", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ address: "missing@example.com", amountUsd: 1 }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown address" });
  });

  it("POST /daily-roster/recipients/update matches the trimmed address and keeps the row comment", async () => {
    const sess = sessionEnv();
    writeFileSync(
      sess.RECIPIENTS_FILE,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [
          {
            address: "alice@walletofsatoshi.com",
            amountUsd: 1,
            comment: "keep",
          },
        ],
      })}\n`,
    );
    const app = createServer({
      env: sess,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const bearer = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };
    const wrongCase = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/update", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({
          address: "Alice@walletofsatoshi.com",
          amountUsd: 4,
        }),
      }),
    );
    const seedRaw = liveFileRaw(sess.STATE_DIR);
    expect(wrongCase.status).toBe(400);
    expect(await wrongCase.json()).toEqual({ error: "Unknown address" });
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect(readLiveRoster(sess.STATE_DIR).recipients).toEqual([
      { address: "alice@walletofsatoshi.com", amountUsd: 1, comment: "keep" },
    ]);
    const padded = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/update", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({
          address: "  alice@walletofsatoshi.com  ",
          amountUsd: 4,
        }),
      }),
    );
    expect(padded.status).toBe(200);
    expect(await padded.json()).toEqual({
      comment: "21gifts daily",
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 4 }],
      moderators: [],
      moderatorPaymentsEnabled: true,
    });
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect(readLiveRoster(sess.STATE_DIR).recipients).toEqual([
      { address: "alice@walletofsatoshi.com", amountUsd: 1, comment: "keep" },
    ]);
  });

  it("POST /daily-roster/recipients/update rejects a zero amount", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/update", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: "alice@walletofsatoshi.com",
          amountUsd: 0,
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid address or amount" });
  });

  it("POST /daily-roster/recipients/delete rejects an unknown address", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/delete", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ address: "missing@example.com" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown address" });
  });

  it("POST /daily-roster/recipients/delete rejects a non-string address", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const bearer = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };
    const numberAddr = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/delete", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ address: 1 }),
      }),
    );
    expect(numberAddr.status).toBe(400);
    expect(await numberAddr.json()).toEqual({ error: "Unknown address" });
    const missing = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/delete", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({}),
      }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Unknown address" });
  });

  it("GET /daily-roster is 500 when recipients.json is not JSON", async () => {
    const sess = sessionEnv();
    const app = createServer({
      env: sess,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    writeFileSync(join(sess.STATE_DIR, "recipients.json"), "not-json");
    const res = await app.fetch(
      dailyRosterReq("/daily-roster", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Recipient list is unreadable" });
  });

  it("GET /daily-roster returns the comment, the switch, the default amount, and recipients", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      comment: "21gifts daily",
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      moderators: [],
      moderatorPaymentsEnabled: true,
    });
  });

  it("GET /daily-roster includes moderators and moderatorPaymentsEnabled", async () => {
    const withMods = sessionEnv();
    writeFileSync(
      withMods.RECIPIENTS_FILE,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        moderatorPaymentsEnabled: false,
      })}\n`,
    );
    const listed = createServer({
      env: withMods,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const listedRes = await listed.fetch(
      dailyRosterReq("/daily-roster", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(listedRes.status).toBe(200);
    expect(await listedRes.json()).toEqual({
      comment: "21gifts daily",
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      moderatorPaymentsEnabled: false,
    });
    const omitted = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const omittedRes = await omitted.fetch(
      dailyRosterReq("/daily-roster", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(omittedRes.status).toBe(200);
    expect(await omittedRes.json()).toEqual({
      comment: "21gifts daily",
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      moderators: [],
      moderatorPaymentsEnabled: true,
    });
  });

  it("unauthenticated POST /moderators/payments redirects to /", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/payments", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "enabled=off",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("daily-roster JSON payments POST ignores Origin, and the moderator cookie switch still rejects it", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const daily = await app.fetch(
      dailyRosterReq("/daily-roster/payments", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(daily.status).toBe(200);
    const moderator = await app.fetch(
      req("http://127.0.0.1/moderators/payments", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `spend_session=${token}`,
          origin: "https://evil.example",
        },
        body: "enabled=off",
      }),
    );
    expect(moderator.status).toBe(403);
  });

  it("daily roster JSON works when the dashboard password is unset", async () => {
    const sess = sessionEnv();
    const { SPEND_DASHBOARD_PASSWORD: _ignored, ...noPassword } = sess;
    const app = createServer({
      env: noPassword,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const daily = await app.fetch(
      dailyRosterReq("/daily-roster/payments", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(daily.status).toBe(200);
    const moderator = await app.fetch(
      req("http://127.0.0.1/moderators/payments", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "enabled=off",
      }),
    );
    expect(moderator.status).toBe(503);
  });

  it("GET /recipients/payments and GET /moderators/payments are 404", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const token = await login(app);
    const daily = await app.fetch(
      req("http://127.0.0.1/recipients/payments", {
        headers: { cookie: `spend_session=${token}` },
      }),
    );
    expect(daily.status).toBe(404);
    const moderator = await app.fetch(
      req("http://127.0.0.1/moderators/payments", {
        headers: { cookie: `spend_session=${token}` },
      }),
    );
    expect(moderator.status).toBe(404);
  });

  it("add, update, and comment save do not reset a stored false flag", async () => {
    const sess = sessionEnv();
    writeFileSync(
      sess.RECIPIENTS_FILE,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
        paymentsEnabled: false,
        moderatorPaymentsEnabled: false,
      })}\n`,
    );
    const app = createServer({
      env: sess,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const seedRaw = liveFileRaw(sess.STATE_DIR);
    const bearer = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };
    const add = await app.fetch(
      dailyRosterReq("/daily-roster/recipients", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({
          address: "carol@walletofsatoshi.com",
          amountUsd: 2,
        }),
      }),
    );
    expect(add.status).toBe(200);
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect(await add.json()).toMatchObject({
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
    });
    const update = await app.fetch(
      dailyRosterReq("/daily-roster/recipients/update", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({
          address: "carol@walletofsatoshi.com",
          amountUsd: 3,
        }),
      }),
    );
    expect(update.status).toBe(200);
    const comment = await app.fetch(
      dailyRosterReq("/daily-roster/comment", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ comment: "hello gifts" }),
      }),
    );
    expect(comment.status).toBe(200);
    expect(liveFileRaw(sess.STATE_DIR)).toBe(seedRaw);
    expect(await comment.json()).toMatchObject({
      comment: "hello gifts",
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
      recipients: [
        { address: "alice@walletofsatoshi.com", amountUsd: 1 },
        { address: "carol@walletofsatoshi.com", amountUsd: 3 },
      ],
      moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
    });
  });
});

describe("daily roster API failures", () => {
  it("GET /daily-roster is 502 when the roster API is down", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Daily roster is unavailable" });
  });

  it("POST /daily-roster/payments is 502 when import fails", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/payments", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Daily roster is unavailable" });
  });

  it("POST /daily-roster/comment is 502 when a worker call is not 400", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async (url) => {
        if (String(url).includes("/funding/daily-roster/document")) {
          return new Response(
            JSON.stringify({
              comment: "21gifts daily",
              paymentsEnabled: true,
              moderatorPaymentsEnabled: true,
              defaultAmountUsd: 1,
              recipients: [
                { address: "alice@walletofsatoshi.com", amountUsd: 1 },
              ],
              moderators: [],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
      },
    });
    const res = await app.fetch(
      dailyRosterReq("/daily-roster/comment", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ comment: "x" }),
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Daily roster is unavailable" });
  });

  it("logged-in GET / is 502 when the roster API is down", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    const token = await login(app);
    const res = await app.fetch(
      req("http://127.0.0.1/", {
        headers: { cookie: `spend_session=${token}` },
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Daily roster is unavailable");
  });

  it("POST /moderators/add is 502 when the roster API is down", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    const token = await login(app);
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/add", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `spend_session=${token}`,
        },
        body: "address=bob@walletofsatoshi.com&amountUsd=2",
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Daily roster is unavailable");
  });

  it("POST /moderators/payments re-renders a worker 400", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async (url) => {
        if (String(url).includes("/funding/daily-roster/document")) {
          return new Response(
            JSON.stringify({
              comment: "21gifts daily",
              paymentsEnabled: true,
              moderatorPaymentsEnabled: true,
              defaultAmountUsd: 1,
              recipients: [
                { address: "alice@walletofsatoshi.com", amountUsd: 1 },
              ],
              moderators: [],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ error: "Invalid payments switch" }),
          { status: 400 },
        );
      },
    });
    const token = await login(app);
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/payments", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `spend_session=${token}`,
        },
        body: "enabled=off",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Invalid payments switch");
  });

  it("POST /moderators/payments is 502 when a worker call is not 400", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async (url) => {
        if (String(url).includes("/funding/daily-roster/document")) {
          return new Response(
            JSON.stringify({
              comment: "21gifts daily",
              paymentsEnabled: true,
              moderatorPaymentsEnabled: true,
              defaultAmountUsd: 1,
              recipients: [
                { address: "alice@walletofsatoshi.com", amountUsd: 1 },
              ],
              moderators: [],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
      },
    });
    const token = await login(app);
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/payments", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `spend_session=${token}`,
        },
        body: "enabled=off",
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Daily roster is unavailable");
  });

  it("POST /moderators/add is 502 when a worker call is not 400", async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async (url) => {
        if (String(url).includes("/funding/daily-roster/document")) {
          return new Response(
            JSON.stringify({
              comment: "21gifts daily",
              paymentsEnabled: true,
              moderatorPaymentsEnabled: true,
              defaultAmountUsd: 1,
              recipients: [
                { address: "alice@walletofsatoshi.com", amountUsd: 1 },
              ],
              moderators: [],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
      },
    });
    const token = await login(app);
    const res = await app.fetch(
      req("http://127.0.0.1/moderators/add", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `spend_session=${token}`,
        },
        body: "address=bob@walletofsatoshi.com&amountUsd=2",
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Daily roster is unavailable");
  });
});

describe("GET /debug/recipients", () => {
  it("is 503 when DEBUG_TOKEN is unset", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/debug/recipients"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Debug is not configured" });
  });

  it("boots and is 503 when DEBUG_TOKEN is empty", async () => {
    const app = createServer({
      env: { ...env, DEBUG_TOKEN: "" },
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/debug/recipients"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Debug is not configured" });
  });

  it("is 401 when the token is set but the header is missing", async () => {
    const app = createServer({
      env: { ...sessionEnv(), DEBUG_TOKEN: "secret-debug" },
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(req("http://127.0.0.1/debug/recipients"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("is 401 when the token is set but the bearer is wrong", async () => {
    const app = createServer({
      env: { ...sessionEnv(), DEBUG_TOKEN: "secret-debug" },
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/debug/recipients", {
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns the live comment and roster without a session cookie", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sess = sessionEnv();
    writeFileSync(
      sess.RECIPIENTS_FILE,
      `${JSON.stringify({
        comment: "21gifts daily",
        recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      })}\n`,
    );
    const app = createServer({
      env: { ...sess, DEBUG_TOKEN: "secret-debug" },
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/debug/recipients", {
        headers: { authorization: "Bearer secret-debug" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      comment: "21gifts daily",
      recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
      moderators: [{ address: "bob@walletofsatoshi.com", amountUsd: 7.5 }],
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("spend.debug.recipients");
    expect(logged).toContain('"count":1');
    expect(logged).not.toContain("21gifts daily");
    expect(logged).not.toContain("secret-debug");
    expect(logged).not.toContain("alice@walletofsatoshi.com");
    warn.mockRestore();
  });

  it("HEAD with a matching Bearer is 200 with an empty JSON body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      env: { ...sessionEnv(), DEBUG_TOKEN: "secret-debug" },
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/debug/recipients", {
        method: "HEAD",
        headers: { authorization: "Bearer secret-debug" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    warn.mockRestore();
  });

  it("is 502 when the roster API is down", async () => {
    const app = createServer({
      env: { ...sessionEnv(), DEBUG_TOKEN: "secret-debug" },
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    const res = await app.fetch(
      req("http://127.0.0.1/debug/recipients", {
        headers: { authorization: "Bearer secret-debug" },
      }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Daily roster is unavailable" });
  });

  it("is 500 when the live file is corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-debug-bad-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
      seed,
      '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n',
    );
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        DEBUG_TOKEN: "secret-debug",
      },
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    writeFileSync(join(dir, "recipients.json"), "{");
    const res = await app.fetch(
      req("http://127.0.0.1/debug/recipients", {
        headers: { authorization: "Bearer secret-debug" },
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Recipient list is unreadable" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("HEAD is 503 with an empty body when the token is unset", async () => {
    const app = createServer({
      env,
      fetchImpl: withRosterApi(async () => {
        throw new Error("no network");
      }),
    });
    const res = await app.fetch(
      req("http://127.0.0.1/debug/recipients", { method: "HEAD" }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("");
  });
});
