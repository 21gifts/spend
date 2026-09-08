import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { GiftsApi } from '../gifts-api';
import { createServer } from '../server';
import { runDay } from '../run';

const FIXTURE_PR =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

const API_DIR = process.env['GIFTS_API_DIR'];

describe.skipIf(API_DIR === undefined || API_DIR === '')('with 21gifts/api', () => {
  it('dry-runs an invoice through createApp after a UI add', async () => {
    const dir = API_DIR as string;
    const mod = (await import(pathToFileURL(join(dir, 'src/server.ts')).href)) as {
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
            viewKey: string;
            createdAt: number;
            rulesAgreedAt: number | null;
          }) => Promise<void>;
          createPasskeyCredential: (credential: {
            credentialId: string;
            publicKey: Uint8Array;
            signCount: number;
            accountId: string;
            createdAt: number;
          }) => Promise<boolean>;
        };
      }) => { fetch: (req: Request) => Promise<Response> };
    };
    const storeMod = (await import(pathToFileURL(join(dir, 'src/lib/auth/store.ts')).href)) as {
      InMemoryAuthStore: new () => {
        createAccount: (account: {
          id: string;
          linkingKey: string | null;
          role: string;
          name: string | null;
          lightningAddress: string | null;
          lightningAddressVerified: boolean;
          forumLawsDismissed: boolean;
          viewKey: string;
          createdAt: number;
          rulesAgreedAt: number | null;
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
    const authStore = new storeMod.InMemoryAuthStore();
    await authStore.createAccount({
      id: 'alice',
      linkingKey: null,
      role: 'basis',
      name: 'Alice',
      lightningAddress: 'alice@walletofsatoshi.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 1,
    });
    await authStore.createPasskeyCredential({
      credentialId: 'cred-alice',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'alice',
      createdAt: 1,
    });
    await authStore.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: 'bob@walletofsatoshi.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 1,
    });
    await authStore.createPasskeyCredential({
      credentialId: 'cred-bob',
      publicKey: new Uint8Array([2]),
      signCount: 0,
      accountId: 'bob',
      createdAt: 1,
    });
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://ln.example/cb',
            minSendable: 1000,
            maxSendable: 1e12,
            commentAllowed: 255,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ pr: FIXTURE_PR }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const api = mod.createApp({ spendApiToken: 'e2e-spend-token', fetchImpl, authStore });
    const stateDir = mkdtempSync(join(tmpdir(), 'spend-e2e-'));
    const seed = join(stateDir, 'seed.json');
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: '21gifts daily',
        recipients: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
      })}\n`,
    );
    const spend = createServer({
      env: {
        GIFTS_API_URL: 'http://api.example',
        GIFTS_API_TOKEN: 'e2e-spend-token',
        LNDHUB_URI: 'lndhub://admin:secret@https://lightning.space/lndhub',
        RECIPIENTS_FILE: seed,
        STATE_DIR: stateDir,
        SPEND_DASHBOARD_PASSWORD: 'test-password',
        SPEND_LIVE: 'false',
      },
      fetchImpl: async () => new Response('{}', { status: 200 }),
      runDay: (config, options) => {
        const apiFetch: typeof fetch = async (url, init) => {
          const parsed = new URL(String(url), 'http://api.example');
          const headers = new Headers(init?.headers);
          const method = init?.method ?? 'GET';
          const target = `http://127.0.0.1${parsed.pathname}${parsed.search}`;
          if (init?.body === undefined || init.body === null) {
            return api.fetch(new Request(target, { method, headers }));
          }
          return api.fetch(new Request(target, { method, headers, body: init.body }));
        };
        return runDay(config, options, {
          btcUsd: async () => 400,
          gifts: new GiftsApi(config.giftsApiUrl, config.giftsApiToken, apiFetch),
        });
      },
    });
    const login = await spend.fetch(
      new Request('http://127.0.0.1/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://127.0.0.1',
          host: '127.0.0.1',
        },
        body: 'password=test-password',
      }),
    );
    const token = /spend_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
    await spend.fetch(
      new Request('http://127.0.0.1/recipients/add', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `spend_session=${token}`,
          origin: 'http://127.0.0.1',
          host: '127.0.0.1',
        },
        body: 'address=bob@walletofsatoshi.com&amountUsd=1',
      }),
    );
    const invoices: string[] = [];
    const origWarn = console.warn;
    console.warn = ((msg?: unknown, ...rest: unknown[]) => {
      const line = typeof msg === 'string' ? msg : '';
      if (line.includes('"event":"spend.invoice"')) {
        invoices.push(line);
      }
      origWarn(msg, ...rest);
    }) as typeof console.warn;
    try {
      const result = await spend.runPayout('2026-08-28');
      expect(result.exitCode).toBe(0);
      expect(invoices.length).toBe(2);
      expect(invoices.every((line) => line.includes('"amountSats":250000'))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
