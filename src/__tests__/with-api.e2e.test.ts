import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GiftsApi } from "../gifts-api";
import { createServer } from "../server";
import { runDay } from "../run";

const FIXTURE_PR =
  "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp";

const API_DIR = process.env["GIFTS_API_DIR"];

describe.skipIf(API_DIR === undefined || API_DIR === "")(
  "with 21gifts/api",
  () => {
    it("dry-runs an invoice through createApp after a daily-roster JSON add", async () => {
      const dir = API_DIR as string;
      const mod = (await import(
        pathToFileURL(join(dir, "src/server.ts")).href
      )) as {
        createApp: (deps?: {
          spendApiToken?: string;
          fetchImpl?: typeof fetch;
          authStore?: {
            createAccount: (account: {
              id: string;
              linkingKey: string | null;
              role: string;
              name: string | null;
              lightningAddress: string | null;
              lightningAddressVerified: boolean;
              forumLawsDismissed: boolean;
              location?: string | null;
              viewKey: string;
              createdAt: number;
              rulesAgreedAt: number | null;
              isPlatform?: boolean;
            }) => Promise<void>;
            createPasskeyCredential: (credential: {
              credentialId: string;
              publicKey: Uint8Array;
              signCount: number;
              accountId: string;
              createdAt: number;
            }) => Promise<boolean>;
          };
          messageStore?: unknown;
          fundingStore?: unknown;
        }) => { fetch: (req: Request) => Promise<Response> };
      };
      const storeMod = (await import(
        pathToFileURL(join(dir, "src/lib/auth/store.ts")).href
      )) as {
        InMemoryAuthStore: new () => {
          createAccount: (account: {
            id: string;
            linkingKey: string | null;
            role: string;
            name: string | null;
            lightningAddress: string | null;
            lightningAddressVerified: boolean;
            forumLawsDismissed: boolean;
            location?: string | null;
            viewKey: string;
            createdAt: number;
            rulesAgreedAt: number | null;
            isPlatform?: boolean;
          }) => Promise<void>;
          createPasskeyCredential: (credential: {
            credentialId: string;
            publicKey: Uint8Array;
            signCount: number;
            accountId: string;
            createdAt: number;
          }) => Promise<boolean>;
        };
      };
      const msgStoreMod = (await import(
        pathToFileURL(join(dir, "src/lib/message-store.ts")).href
      )) as {
        InMemoryMessageStore: new (seed?: readonly unknown[]) => unknown;
      };
      const messageMod = (await import(
        pathToFileURL(join(dir, "src/lib/message.ts")).href
      )) as {
        unsignedNostrDefaults: () => Record<string, unknown>;
      };
      const authStore = new storeMod.InMemoryAuthStore();
      await authStore.createAccount({
        id: "alice",
        linkingKey: null,
        role: "verified",
        name: "Alice",
        lightningAddress: "alice@walletofsatoshi.com",
        lightningAddressVerified: true,
        forumLawsDismissed: false,
        viewKey: "a".repeat(64),
        createdAt: 1,
        rulesAgreedAt: 1,
      });
      await authStore.createPasskeyCredential({
        credentialId: "cred-alice",
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: "alice",
        createdAt: 1,
      });
      await authStore.createAccount({
        id: "bob",
        linkingKey: null,
        role: "verified",
        name: "Bob",
        lightningAddress: "bob@walletofsatoshi.com",
        lightningAddressVerified: true,
        forumLawsDismissed: false,
        viewKey: "b".repeat(64),
        createdAt: 1,
        rulesAgreedAt: 1,
      });
      await authStore.createPasskeyCredential({
        credentialId: "cred-bob",
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: "bob",
        createdAt: 1,
      });
      await authStore.createAccount({
        id: "plat",
        linkingKey: null,
        role: "founder",
        name: "21.gifts",
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        location: null,
        viewKey: "c".repeat(64),
        createdAt: 2,
        rulesAgreedAt: null,
        isPlatform: true,
      });
      const messageStore = new msgStoreMod.InMemoryMessageStore([
        {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          accountId: "alice",
          name: "Alice",
          text: "first",
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          hasPhoto: true,
          hasVideo: true,
          ...messageMod.unsignedNostrDefaults(),
        },
        {
          id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          accountId: "bob",
          name: "Bob",
          text: "first",
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          hasPhoto: true,
          hasVideo: true,
          ...messageMod.unsignedNostrDefaults(),
        },
      ]);
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes("/.well-known/lnurlp/")) {
          return new Response(
            JSON.stringify({
              callback: "https://ln.example/cb",
              minSendable: 1000,
              maxSendable: 1e12,
              commentAllowed: 255,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ pr: FIXTURE_PR }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      let fundingStore: unknown | undefined;
      try {
        const fundingMod = (await import(
          pathToFileURL(join(dir, "src/lib/funding-store.ts")).href
        )) as {
          InMemoryFundingStore: new (seed?: readonly unknown[]) => unknown;
        };
        const admitted = (accountId: string) => ({
          accountId,
          status: "admitted",
          appliedAt: 1,
          decidedAt: 1,
          decidedBy: null,
          trialUtcDate: null,
          admittedAt: 1,
          note: null,
        });
        fundingStore = new fundingMod.InMemoryFundingStore([
          admitted("alice"),
          admitted("bob"),
        ]);
      } catch {
        fundingStore = undefined;
      }
      const api = mod.createApp({
        spendApiToken: "e2e-spend-token",
        fetchImpl,
        authStore,
        messageStore,
        ...(fundingStore === undefined ? {} : { fundingStore }),
      });
      const stateDir = mkdtempSync(join(tmpdir(), "spend-e2e-"));
      const seed = join(stateDir, "seed.json");
      writeFileSync(
        seed,
        `${JSON.stringify({
          comment: "21gifts daily",
          recipients: [{ address: "alice@walletofsatoshi.com", amountUsd: 1 }],
        })}\n`,
      );
      const apiFetch: typeof fetch = async (url, init) => {
        const parsed = new URL(String(url), "http://api.example");
        const headers = new Headers(init?.headers);
        const method = init?.method ?? "GET";
        const target = `http://127.0.0.1${parsed.pathname}${parsed.search}`;
        const reqInit: RequestInit =
          init?.body === undefined || init.body === null
            ? { method, headers }
            : { method, headers, body: init.body };
        return api.fetch(new Request(target, reqInit));
      };
      const spend = createServer({
        env: {
          GIFTS_API_URL: "http://api.example",
          GIFTS_API_TOKEN: "e2e-spend-token",
          LNDHUB_URI: "lndhub://admin:secret@https://lightning.space/lndhub",
          RECIPIENTS_FILE: seed,
          STATE_DIR: stateDir,
          SPEND_DASHBOARD_PASSWORD: "test-password",
          SPEND_LIVE: "false",
        },
        fetchImpl: async (url, init) => {
          const parsed = new URL(String(url), "http://api.example");
          if (parsed.pathname.startsWith("/funding/daily-roster")) {
            return apiFetch(url, init);
          }
          return new Response("{}", { status: 200 });
        },
        runDay: (config, options) =>
          runDay(config, options, {
            btcUsd: async () => 400,
            gifts: new GiftsApi(
              config.giftsApiUrl,
              config.giftsApiToken,
              apiFetch,
            ),
          }),
      });
      const added = await spend.fetch(
        new Request("http://127.0.0.1/daily-roster/recipients", {
          method: "POST",
          headers: {
            authorization: "Bearer e2e-spend-token",
            "content-type": "application/json",
            host: "127.0.0.1",
          },
          body: JSON.stringify({
            address: "bob@walletofsatoshi.com",
            amountUsd: 1,
          }),
        }),
      );
      expect(added.status).toBe(200);
      const invoices: string[] = [];
      const origWarn = console.warn;
      console.warn = ((msg?: unknown, ...rest: unknown[]) => {
        const line = typeof msg === "string" ? msg : "";
        if (line.includes('"event":"spend.invoice"')) {
          invoices.push(line);
        }
        origWarn(msg, ...rest);
      }) as typeof console.warn;
      try {
        const ping = (address: string, messageId: string): Promise<Response> =>
          spend.fetch(
            new Request("http://127.0.0.1/ping", {
              method: "POST",
              headers: {
                authorization: "Bearer e2e-spend-token",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                address,
                amountUsd: 1,
                comment: "e2e daily",
                messageId,
              }),
            }),
          );
        expect(
          (
            await ping(
              "alice@walletofsatoshi.com",
              "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            )
          ).status,
        ).toBe(202);
        expect(
          (
            await ping(
              "bob@walletofsatoshi.com",
              "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            )
          ).status,
        ).toBe(202);
        await spend.drainPayouts();
        expect(invoices.length).toBe(2);
        expect(
          invoices.every((line) => line.includes('"amountSats":250000')),
        ).toBe(true);
      } finally {
        console.warn = origWarn;
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  },
);
