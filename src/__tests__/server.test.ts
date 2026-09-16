import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { MODERATOR_STIPEND_USD } from '../config';
import { createServer, parseBindAddr } from '../server';

const stateDir = mkdtempSync(join(tmpdir(), 'spend-server-'));
const seedPath = join(stateDir, 'seed.json');
writeFileSync(
  seedPath,
  `${JSON.stringify({
    comment: '21gifts daily',
    recipients: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
  })}\n`,
);

const env = {
  GIFTS_API_URL: 'http://api.example',
  GIFTS_API_TOKEN: 'tok',
  LNDHUB_URI: 'lndhub://admin:secret@https://lightning.space/lndhub',
  RECIPIENTS_FILE: seedPath,
  STATE_DIR: stateDir,
};

const sessionDirs: string[] = [];

function req(url: string, init?: RequestInit): Request {
  const parsed = new URL(url);
  const headers = new Headers(init?.headers);
  if (!headers.has('host')) {
    headers.set('host', parsed.host);
  }
  if ((init?.method ?? 'GET') === 'POST' && !headers.has('origin')) {
    headers.set('origin', parsed.origin);
  }
  return new Request(url, { ...init, headers });
}

/** `POST /ping` without Origin — the route is api-to-api and must not require it. */
function pingReq(init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (!headers.has('host')) {
    headers.set('host', '127.0.0.1');
  }
  return new Request('http://127.0.0.1/ping', { ...init, method: 'POST', headers });
}

const PING_MESSAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  for (const dir of sessionDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseBindAddr', () => {
  it('parses host and port', () => {
    expect(parseBindAddr('0.0.0.0:3000')).toEqual({ hostname: '0.0.0.0', port: 3000 });
  });

  it('defaults when unset, empty, or malformed', () => {
    expect(parseBindAddr(undefined)).toEqual({ hostname: '0.0.0.0', port: 3000 });
    expect(parseBindAddr('')).toEqual({ hostname: '0.0.0.0', port: 3000 });
    expect(parseBindAddr('nope')).toEqual({ hostname: '0.0.0.0', port: 3000 });
    expect(parseBindAddr(':80')).toEqual({ hostname: '0.0.0.0', port: 3000 });
    expect(parseBindAddr('host:')).toEqual({ hostname: '0.0.0.0', port: 3000 });
    expect(parseBindAddr('host:99999')).toEqual({ hostname: '0.0.0.0', port: 3000 });
  });
});

describe('createServer', () => {
  it('returns 404 for other paths without LNDHub I/O', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/nope'));
    expect(res.status).toBe(404);
  });

  it('serves healthz without LNDHub I/O', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/healthz'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('spend');
  });

  it('HEAD /healthz is 200 with empty body and no fetch', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/healthz', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('renders sats on GET / without password and has no Log in', async () => {
    const app = createServer({
      env: { ...env, SPEND_LIGHTNING_ADDRESS: '9643e3@lightning.space' },
      fetchImpl: async (url) => {
        const path = String(url);
        if (path.endsWith('/auth')) {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
        }
        if (path.endsWith('/balance')) {
          return new Response(JSON.stringify({ BTC: { AvailableBalance: 3803 } }), { status: 200 });
        }
        if (path.includes('coinbase.com')) {
          return new Response(JSON.stringify({ data: { amount: '78883.06' } }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('3803 sats');
    expect(html).toContain(`${((3803 / 1e8) * 78883.06).toFixed(2)} USD`);
    expect(html).toContain('9643e3@lightning.space');
    expect(html).toContain('Lightning address');
    expect(html).toContain('<svg');
    expect(html).not.toContain('bc1q');
    expect(html).not.toContain('Deposit address');
    expect(html).not.toContain('/getbtc');
    expect(html).not.toContain('/login');
    expect(html).not.toContain('/recipients');
    expect(html).not.toContain('Log in');
  });

  it('GET / with password shows the login form', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="password"');
    expect(html).toContain('Log in');
    expect(html).toContain('action="/"');
    expect(html).toContain('unavailable');
    expect(html).not.toContain('action="/recipients/comment"');
    expect(html).not.toContain('name="comment"');
    expect(html).not.toContain('Payment comment');
  });

  it('HEAD / is 200 with empty body and does not load the dashboard', async () => {
    const app = createServer({
      env: { ...env, SPEND_LIGHTNING_ADDRESS: '9643e3@lightning.space' },
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('startScheduler is a no-op and does not invoke runDay', async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const live = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const liveHandle = live.startScheduler();
    await Promise.resolve();
    liveHandle.stop();
    const dry = createServer({
      env,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const dryHandle = dry.startScheduler();
    await Promise.resolve();
    dryHandle.stop();
    expect(runDay).not.toHaveBeenCalled();
  });

  it('startCatchup always resolves null and does not invoke runDay', async () => {
    const runDay = vi.fn(async () => {
      throw new Error('boom');
    });
    const live = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-27T00:43:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    await expect(live.startCatchup()).resolves.toBeNull();
    const dry = createServer({
      env,
      now: () => new Date('2026-08-27T00:43:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    await expect(dry.startCatchup()).resolves.toBeNull();
    expect(runDay).not.toHaveBeenCalled();
  });

  it('startRetryCatchup is a no-op and does not invoke runDay', async () => {
    vi.useFakeTimers();
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const live = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      retryCatchupMs: 20,
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const liveHandle = live.startRetryCatchup();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    liveHandle.stop();
    const dry = createServer({
      env,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      retryCatchupMs: 20,
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const dryHandle = dry.startRetryCatchup();
    await vi.advanceTimersByTimeAsync(20);
    dryHandle.stop();
    expect(runDay).not.toHaveBeenCalled();
  });

  it('fails closed on boot when only one Telegram env is set', () => {
    expect(() =>
      createServer({
        env: { ...env, TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx' },
        fetchImpl: async () => {
          throw new Error('no network');
        },
      }),
    ).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it('startScheduler does not notify Telegram', async () => {
    const telegramCalls: string[] = [];
    const runDay = vi.fn(async () => ({
      exitCode: 0,
      summary: {
        day: '2026-08-25',
        live: true,
        ok: true,
        exitCode: 0,
        paid: [{ address: 'alice@walletofsatoshi.com', amountSats: 1000, amountUsd: 1 }],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const app = createServer({
      env: {
        ...env,
        SPEND_LIVE: 'true',
        TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx',
        TELEGRAM_CHAT_ID: '-1001234567890',
      },
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      runDay,
      fetchImpl: async (url) => {
        if (String(url).includes('api.telegram.org')) {
          telegramCalls.push(String(url));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    const handle = app.startScheduler();
    await Promise.resolve();
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramCalls).toEqual([]);
    handle.stop();
  });

  it('startCatchup does not notify Telegram', async () => {
    const telegramCalls: string[] = [];
    const runDay = vi.fn(async () => ({
      exitCode: 0,
      summary: {
        day: '2026-08-27',
        live: true,
        ok: true,
        exitCode: 0,
        paid: [],
        skipped: [{ address: 'alice@walletofsatoshi.com', reason: 'paid' }],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const app = createServer({
      env: {
        ...env,
        SPEND_LIVE: 'true',
        TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx',
        TELEGRAM_CHAT_ID: '-1001234567890',
      },
      now: () => new Date('2026-08-27T00:43:00.000Z'),
      runDay,
      fetchImpl: async (url) => {
        if (String(url).includes('api.telegram.org')) {
          telegramCalls.push(String(url));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    await expect(app.startCatchup()).resolves.toBeNull();
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramCalls).toEqual([]);
  });

  it('POST /ping is 401 without Bearer or with a wrong Bearer', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const missing = await app.fetch(
      pingReq({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'alice@walletofsatoshi.com', messageId: PING_MESSAGE_ID }),
      }),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Unauthorized' });
    const wrong = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'alice@walletofsatoshi.com', messageId: PING_MESSAGE_ID }),
      }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Unauthorized' });
  });

  it('POST /ping is 400 for bad JSON or a missing address', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const badJson = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: 'Expected a JSON body with address' });
    const missing = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'Expected a JSON body with address' });
  });

  it('POST /ping is 400 without messageId', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'alice@walletofsatoshi.com' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with address and messageId',
    });
  });

  it('POST /ping is 400 for an invalid messageId', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'alice@walletofsatoshi.com', messageId: 'nope' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with address and messageId',
    });
  });

  it('POST /ping is 400 for an invalid address', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'not-an-address', messageId: PING_MESSAGE_ID }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('POST /ping is 200 skipped not_listed when the address is off the roster', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'bob@walletofsatoshi.com', messageId: PING_MESSAGE_ID }),
      }),
    );
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'skipped', reason: 'not_listed' });
  });

  it('POST /ping is 200 skipped paid when today JSONL already has a paid row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-ping-paid-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: '21gifts daily',
        recipients: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, '2026-08-25.jsonl'),
      `${JSON.stringify({
        ts: 't',
        address: 'alice@walletofsatoshi.com',
        invoiceId: '1',
        paymentHash: '',
        status: 'paid',
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date('2026-08-25T12:00:00.000Z'),
        runDay,
        fetchImpl: async () => {
          throw new Error('no network');
        },
      });
      const res = await app.fetch(
        pingReq({
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: JSON.stringify({ address: 'alice@walletofsatoshi.com', messageId: PING_MESSAGE_ID }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'skipped', reason: 'paid' });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /ping is 200 skipped uncertain when another live recipient is uncertain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-ping-uncertain-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: '21gifts daily',
        recipients: [
          { address: 'alice@walletofsatoshi.com', amountUsd: 1 },
          { address: 'bob@walletofsatoshi.com', amountUsd: 1 },
        ],
      })}\n`,
    );
    writeFileSync(join(dir, 'recipients.json'), readFileSync(seed, 'utf8'));
    writeFileSync(
      join(dir, '2026-08-25.jsonl'),
      `${JSON.stringify({
        ts: 't',
        address: 'bob@walletofsatoshi.com',
        invoiceId: '1',
        paymentHash: '',
        status: 'uncertain',
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed },
        now: () => new Date('2026-08-25T12:00:00.000Z'),
        runDay,
        fetchImpl: async () => {
          throw new Error('no network');
        },
      });
      const res = await app.fetch(
        pingReq({
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: JSON.stringify({ address: 'alice@walletofsatoshi.com', messageId: PING_MESSAGE_ID }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'skipped', reason: 'uncertain' });
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /ping is 202 accepted and queues runDay with onlyAddresses without Origin', async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-25T12:00:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const res = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'alice@walletofsatoshi.com', messageId: PING_MESSAGE_ID }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalled();
    });
    expect(runDay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        live: true,
        day: '2026-08-25',
        onlyAddresses: ['alice@walletofsatoshi.com'],
        messageIdByAddress: {
          'alice@walletofsatoshi.com': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
      }),
    );
    await app.drainPayouts();
    warn.mockRestore();
  });

  it('POST /ping kind moderator is 202 and queues a 5 USD stipend without messageIdByAddress', async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-25T12:00:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const res = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'bob@walletofsatoshi.com', kind: 'moderator' }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });
    await vi.waitFor(() => {
      expect(runDay).toHaveBeenCalled();
    });
    expect(runDay).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [
          {
            address: 'bob@walletofsatoshi.com',
            amountUsd: MODERATOR_STIPEND_USD,
            comment: '21gifts moderator',
          },
        ],
        comment: '21gifts moderator',
      }),
      expect.objectContaining({
        live: true,
        day: '2026-08-25',
        onlyAddresses: ['bob@walletofsatoshi.com'],
        bucket: 'moderator',
      }),
    );
    const pingArgs = runDay.mock.calls[0] as unknown[] | undefined;
    expect(pingArgs?.[1]).not.toHaveProperty('messageIdByAddress');
    await app.drainPayouts();
    const pingLogs = warn.mock.calls
      .map((args) => String(args[0] ?? ''))
      .filter((line) => line.includes('"event":"spend.ping"'));
    expect(
      pingLogs.some(
        (line) => line.includes('"kind":"moderator"') && line.includes('"status":"accepted"'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('POST /ping kind moderator skips only the moderator JSONL and is independent of the daily file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-ping-mod-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(
      seed,
      `${JSON.stringify({
        comment: '21gifts daily',
        recipients: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
      })}\n`,
    );
    writeFileSync(
      join(dir, '2026-08-25.jsonl'),
      `${JSON.stringify({
        ts: 't',
        address: 'bob@walletofsatoshi.com',
        invoiceId: '1',
        paymentHash: '',
        status: 'paid',
      })}\n`,
    );
    const paidRow = (address: string): string =>
      `${JSON.stringify({
        ts: 't',
        address,
        invoiceId: '1',
        paymentHash: '',
        status: 'paid',
      })}\n`;
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, RECIPIENTS_FILE: seed, SPEND_LIVE: 'true' },
        now: () => new Date('2026-08-25T12:00:00.000Z'),
        runDay,
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      const moderatorPing = (): Promise<Response> =>
        app.fetch(
          pingReq({
            headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
            body: JSON.stringify({ address: 'bob@walletofsatoshi.com', kind: 'moderator' }),
          }),
        );
      const first = await moderatorPing();
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ status: 'accepted' });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalledTimes(1);
      });
      writeFileSync(join(dir, '2026-08-25.moderator.jsonl'), paidRow('bob@walletofsatoshi.com'));
      const skipped = await moderatorPing();
      expect(skipped.status).toBe(200);
      expect(await skipped.json()).toEqual({ status: 'skipped', reason: 'paid' });
      expect(runDay).toHaveBeenCalledTimes(1);
      const dailyAlice = await app.fetch(
        pingReq({
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: JSON.stringify({
            address: 'alice@walletofsatoshi.com',
            messageId: PING_MESSAGE_ID,
          }),
        }),
      );
      expect(dailyAlice.status).toBe(202);
      expect(await dailyAlice.json()).toEqual({ status: 'accepted' });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalledTimes(2);
      });
      writeFileSync(
        join(dir, '2026-08-25.moderator.jsonl'),
        `${paidRow('bob@walletofsatoshi.com')}${paidRow('alice@walletofsatoshi.com')}`,
      );
      const dailyAliceAgain = await app.fetch(
        pingReq({
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: JSON.stringify({
            address: 'alice@walletofsatoshi.com',
            messageId: PING_MESSAGE_ID,
          }),
        }),
      );
      expect(dailyAliceAgain.status).toBe(202);
      expect(await dailyAliceAgain.json()).toEqual({ status: 'accepted' });
      await vi.waitFor(() => {
        expect(runDay).toHaveBeenCalledTimes(3);
      });
      await app.drainPayouts();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /ping kind moderator is 400 when messageId is present', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({
          address: 'alice@walletofsatoshi.com',
          kind: 'moderator',
          messageId: PING_MESSAGE_ID,
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with address and kind',
    });
  });

  it('POST /ping is 400 for an invalid kind', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'alice@walletofsatoshi.com', kind: 'nope' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with address and kind',
    });
  });

  it('drainPayouts waits for an in-flight ping payout', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runDay = vi.fn(async () => {
      await blocked;
      return { exitCode: 0 };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const res = await app.fetch(
      pingReq({
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'alice@walletofsatoshi.com', messageId: PING_MESSAGE_ID }),
      }),
    );
    expect(res.status).toBe(202);
    const drained = app.drainPayouts();
    release();
    await expect(drained).resolves.toBeUndefined();
    expect(runDay).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('runPayout notifies with a minimal summary when runDay omits summary', async () => {
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env: {
        ...env,
        TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx',
        TELEGRAM_CHAT_ID: '-1001234567890',
      },
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    await expect(app.runPayout('2026-08-28')).resolves.toEqual({ exitCode: 0 });
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      chat_id: '-1001234567890',
      text: expect.stringContaining('source=scheduler'),
      disable_web_page_preview: true,
    });
  });
});

function cookieFrom(res: Response): string {
  return res.headers.get('set-cookie') ?? '';
}

function sessionEnv(): typeof env & { SPEND_DASHBOARD_PASSWORD: string } {
  const dir = mkdtempSync(join(tmpdir(), 'spend-sess-'));
  sessionDirs.push(dir);
  const seed = join(dir, 'seed.json');
  writeFileSync(
    seed,
    `${JSON.stringify({
      comment: '21gifts daily',
      recipients: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
    })}\n`,
  );
  return {
    ...env,
    STATE_DIR: dir,
    RECIPIENTS_FILE: seed,
    SPEND_DASHBOARD_PASSWORD: 'test-password',
  };
}

async function login(app: ReturnType<typeof createServer>, password = 'test-password'): Promise<string> {
  const res = await app.fetch(
    req('http://127.0.0.1/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(password)}`,
    }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe('/');
  const setCookie = cookieFrom(res);
  const match = /spend_session=([^;]+)/.exec(setCookie);
  return match?.[1] ?? '';
}

describe('recipient editor', () => {
  it('GET /login redirects to / when a password is configured', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/login'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });

  it('GET /login is 503 when the password is unset', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/login'));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Recipient editor is not configured');
  });

  it('POST /login is 503 when the password is unset', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      req('http://127.0.0.1/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=x',
      }),
    );
    expect(res.status).toBe(503);
  });

  it('rejects a wrong password without a session cookie', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      req('http://127.0.0.1/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=nope',
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Invalid password');
    expect(html).toContain('name="password"');
    expect(cookieFrom(res)).not.toContain('spend_session=v1.');
  });

  it('logs in from a raw form body without a content-type', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      req('http://127.0.0.1/login', {
        method: 'POST',
        body: 'password=test-password',
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(cookieFrom(res)).toContain('spend_session=v1.');
  });

  it('logs in and lists seeded recipients on GET /', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    expect(token.startsWith('v1.')).toBe(true);
    const res = await app.fetch(
      req('http://127.0.0.1/', { headers: { cookie: `spend_session=${token}` } }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice@walletofsatoshi.com');
    expect(html).toContain('Log out');
    expect(html).toContain('>21gifts daily</textarea>');
    expect(html).toContain('Payment comment');
  });

  it('GET /recipients without a cookie redirects to /', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/recipients'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });

  it('GET /recipients with a cookie redirects to /', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const res = await app.fetch(
      req('http://127.0.0.1/recipients', { headers: { cookie: `spend_session=${token}` } }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });

  it('GET /recipients is 503 when the password is unset', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/recipients'));
    expect(res.status).toBe(503);
  });

  it('rejects a cross-origin mutation', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/add', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `spend_session=${token}`,
          origin: 'https://evil.example',
        },
        body: 'address=bob@walletofsatoshi.com&amountUsd=2',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('unauthenticated POST /recipients/add redirects to /', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/add', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'address=bob@walletofsatoshi.com&amountUsd=2',
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });

  it('keeps both recipients when two adds overlap', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const post = (address: string): Promise<Response> =>
      app.fetch(
        req('http://127.0.0.1/recipients/add', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
          body: `address=${encodeURIComponent(address)}&amountUsd=2`,
        }),
      );
    const [first, second] = await Promise.all([
      post('bob@walletofsatoshi.com'),
      post('carol@walletofsatoshi.com'),
    ]);
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('/');
    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toBe('/');
    const listed = await app.fetch(req('http://127.0.0.1/', { headers: { cookie } }));
    const html = await listed.text();
    expect(html).toContain('bob@walletofsatoshi.com');
    expect(html).toContain('carol@walletofsatoshi.com');
  });

  it('adds, updates, and deletes recipients', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const add = await app.fetch(
      req('http://127.0.0.1/recipients/add', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=bob@walletofsatoshi.com&amountUsd=2',
      }),
    );
    expect(add.status).toBe(303);
    expect(add.headers.get('location')).toBe('/');
    const dup = await app.fetch(
      req('http://127.0.0.1/recipients/add', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=bob@walletofsatoshi.com&amountUsd=9',
      }),
    );
    expect(dup.status).toBe(200);
    expect(await dup.text()).toContain('Address already listed');
    const badAdd = await app.fetch(
      req('http://127.0.0.1/recipients/add', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=not-an-address&amountUsd=2',
      }),
    );
    expect(await badAdd.text()).toContain('Invalid address or amount');
    const update = await app.fetch(
      req('http://127.0.0.1/recipients/update', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=bob@walletofsatoshi.com&amountUsd=3',
      }),
    );
    expect(update.status).toBe(303);
    expect(update.headers.get('location')).toBe('/');
    const unknown = await app.fetch(
      req('http://127.0.0.1/recipients/update', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=nobody@walletofsatoshi.com&amountUsd=3',
      }),
    );
    expect(await unknown.text()).toContain('Unknown address');
    const badUsd = await app.fetch(
      req('http://127.0.0.1/recipients/update', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=bob@walletofsatoshi.com&amountUsd=0',
      }),
    );
    expect(await badUsd.text()).toContain('Invalid address or amount');
    const listed = await app.fetch(req('http://127.0.0.1/', { headers: { cookie } }));
    expect(await listed.text()).toContain('value="3"');
    const del = await app.fetch(
      req('http://127.0.0.1/recipients/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=bob@walletofsatoshi.com',
      }),
    );
    expect(del.status).toBe(303);
    expect(del.headers.get('location')).toBe('/');
    const delUnknown = await app.fetch(
      req('http://127.0.0.1/recipients/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=bob@walletofsatoshi.com',
      }),
    );
    expect(await delUnknown.text()).toContain('Unknown address');
    await app.fetch(
      req('http://127.0.0.1/recipients/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=alice@walletofsatoshi.com',
      }),
    );
    const empty = await app.fetch(req('http://127.0.0.1/', { headers: { cookie } }));
    expect(await empty.text()).toContain('No recipients');
  });

  it('accepts multipart login and sets Secure when forwarded proto is https', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const form = new FormData();
    form.set('password', 'test-password');
    const res = await app.fetch(
      req('https://spend.example/login', {
        method: 'POST',
        headers: { 'x-forwarded-proto': 'https' },
        body: form,
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(cookieFrom(res)).toContain('Secure');
  });

  it('POST /logout clears the cookie', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/logout', { method: 'POST' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(cookieFrom(res)).toContain('Max-Age=0');
  });

  it('GET / is 500 when the live file is corrupt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-bad-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_DASHBOARD_PASSWORD: 'test-password',
      },
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    writeFileSync(join(dir, 'recipients.json'), '{');
    const res = await app.fetch(
      req('http://127.0.0.1/', { headers: { cookie: `spend_session=${token}` } }),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Recipient list is unreadable');
    rmSync(dir, { recursive: true, force: true });
  });

  it('payout reloads the live list and skips a corrupt file', async () => {
    const sess = sessionEnv();
    const runDay = vi.fn(async (cfg: { recipients: Array<{ address: string }> }) => {
      expect(cfg.recipients.map((r) => r.address)).toEqual(['alice@walletofsatoshi.com', 'bob@walletofsatoshi.com']);
      return { exitCode: 0 };
    });
    const app = createServer({
      env: sess,
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const token = await login(app);
    await app.fetch(
      req('http://127.0.0.1/recipients/add', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `spend_session=${token}`,
        },
        body: 'address=bob@walletofsatoshi.com&amountUsd=2',
      }),
    );
    await expect(app.runPayout('2026-08-28')).resolves.toEqual({ exitCode: 0 });
    writeFileSync(join(sess.STATE_DIR, 'recipients.json'), 'not-json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(app.runPayout('2026-08-28')).resolves.toEqual({ exitCode: 4 });
    expect(JSON.stringify(warn.mock.calls)).toContain('corrupt_recipients');
    warn.mockRestore();
  });

  it('notifies Telegram on corrupt recipients once; catch-up stays silent after runPayout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-corrupt-tg-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    writeFileSync(join(dir, 'recipients.json'), '{');
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: 'true',
        TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx',
        TELEGRAM_CHAT_ID: '-1001234567890',
      },
      now: () => new Date('2026-08-28T12:00:00.000Z'),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    await expect(app.runPayout('2026-08-28')).resolves.toEqual({ exitCode: 4 });
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      chat_id: '-1001234567890',
      text: expect.stringContaining('corrupt_recipients'),
      disable_web_page_preview: true,
    });
    expect(String((telegramBodies[0] as { text: string }).text)).toContain('exit=4');
    expect(String((telegramBodies[0] as { text: string }).text)).toContain('ok=false');

    telegramBodies.length = 0;
    await expect(app.startCatchup()).resolves.toBeNull();
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(0);
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('startCatchup is a no-op when live recipients are corrupt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-corrupt-tg-cu-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    writeFileSync(join(dir, 'recipients.json'), '{');
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: 'true',
        TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx',
        TELEGRAM_CHAT_ID: '-1001234567890',
      },
      now: () => new Date('2026-08-28T12:00:00.000Z'),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    await expect(app.startCatchup()).resolves.toBeNull();
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(0);
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dedupes ping insufficient_balance Telegram until a paid run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-tg-dedupe-cu-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    const telegramBodies: unknown[] = [];
    const insufficient = {
      exitCode: 3,
      summary: {
        day: '2026-09-06',
        live: true,
        ok: false,
        exitCode: 3,
        reason: 'insufficient_balance',
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
          day: '2026-09-06',
          live: true,
          ok: true,
          exitCode: 0,
          paid: [{ address: 'a@b.com', amountSats: 1000 }],
          skipped: [],
          failed: [],
          uncertain: [],
          dryRun: [],
        },
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: 'true',
        TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx',
        TELEGRAM_CHAT_ID: '-1001234567890',
      },
      now: () => new Date('2026-09-06T12:00:00.000Z'),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    const ping = (): Promise<Response> =>
      app.fetch(
        pingReq({
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: JSON.stringify({ address: 'a@b.com', messageId: PING_MESSAGE_ID }),
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
      text: expect.stringContaining('insufficient_balance'),
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
      text: expect.stringContaining('a@b.com'),
    });
    await app.drainPayouts();
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dedupes scheduler insufficient_balance Telegram across two runPayout calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-tg-dedupe-sched-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: '2026-09-06',
        live: true,
        ok: false,
        exitCode: 3,
        reason: 'insufficient_balance',
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
        SPEND_LIVE: 'true',
        TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx',
        TELEGRAM_CHAT_ID: '-1001234567890',
      },
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    await expect(app.runPayout('2026-09-06')).resolves.toEqual({ exitCode: 3 });
    await expect(app.runPayout('2026-09-06')).resolves.toEqual({ exitCode: 3 });
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      text: expect.stringContaining('insufficient_balance'),
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('dedupes ping usd_to_sats Telegram even when failed mirrors the preflight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-tg-dedupe-usd-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    const telegramBodies: unknown[] = [];
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: '2026-09-06',
        live: true,
        ok: false,
        exitCode: 3,
        reason: 'usd_to_sats',
        paid: [],
        skipped: [],
        failed: [{ address: 'a@b.com' }],
        uncertain: [],
        dryRun: [],
      },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: 'true',
        TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx',
        TELEGRAM_CHAT_ID: '-1001234567890',
      },
      now: () => new Date('2026-09-06T12:00:00.000Z'),
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    const ping = (): Promise<Response> =>
      app.fetch(
        pingReq({
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: JSON.stringify({ address: 'a@b.com', messageId: PING_MESSAGE_ID }),
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
      text: expect.stringContaining('usd_to_sats'),
    });
    await app.drainPayouts();
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries Telegram after a failed send; remember only after HTTP ok', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-tg-remember-fail-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    const telegramOkBodies: unknown[] = [];
    let telegramAttempts = 0;
    const runDay = vi.fn(async () => ({
      exitCode: 3,
      summary: {
        day: '2026-09-06',
        live: true,
        ok: false,
        exitCode: 3,
        reason: 'insufficient_balance',
        needed: 1500,
        available: 10,
        paid: [],
        skipped: [],
        failed: [],
        uncertain: [],
        dryRun: [],
      },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        SPEND_LIVE: 'true',
        TELEGRAM_BOT_TOKEN: '123456:AA-testtoken_notreal_xxxxxx',
        TELEGRAM_CHAT_ID: '-1001234567890',
      },
      runDay,
      fetchImpl: async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramAttempts += 1;
          if (telegramAttempts === 1) {
            return new Response('fail', { status: 500 });
          }
          telegramOkBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    await expect(app.runPayout('2026-09-06')).resolves.toEqual({ exitCode: 3 });
    expect(telegramAttempts).toBe(1);
    expect(telegramOkBodies).toHaveLength(0);
    await expect(app.runPayout('2026-09-06')).resolves.toEqual({ exitCode: 3 });
    expect(telegramAttempts).toBe(2);
    expect(telegramOkBodies).toHaveLength(1);
    expect(telegramOkBodies[0]).toMatchObject({
      text: expect.stringContaining('insufficient_balance'),
    });
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('POST /recipients/add is 503 when the password is unset', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/recipients/add', { method: 'POST' }));
    expect(res.status).toBe(503);
  });

  it('POST /recipients/update with a blank address is unknown', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/update', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `spend_session=${token}`,
        },
        body: 'address=&amountUsd=3',
      }),
    );
    expect(await res.text()).toContain('Unknown address');
  });

  it('POST /recipients/delete with a blank address is unknown', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/delete', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `spend_session=${token}`,
        },
        body: 'address=',
      }),
    );
    expect(await res.text()).toContain('Unknown address');
  });

  it('POST /recipients/comment saves the comment and leaves recipients unchanged', async () => {
    const sess = sessionEnv();
    const app = createServer({
      env: sess,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'comment=hello+gifts',
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const listed = await app.fetch(req('http://127.0.0.1/', { headers: { cookie } }));
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain('>hello gifts</textarea>');
    const live = JSON.parse(readFileSync(join(sess.STATE_DIR, 'recipients.json'), 'utf8')) as {
      comment: string;
      recipients: Array<{ address: string; amountUsd: number }>;
    };
    expect(live.comment).toBe('hello gifts');
    expect(live.recipients).toEqual([{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }]);
  });

  it('POST /recipients/comment collapses whitespace and newlines', async () => {
    const sess = sessionEnv();
    const app = createServer({
      env: sess,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'comment=%0A%20foo%0Abar%20',
      }),
    );
    expect(res.status).toBe(303);
    const live = JSON.parse(readFileSync(join(sess.STATE_DIR, 'recipients.json'), 'utf8')) as {
      comment: string;
    };
    expect(live.comment).toBe('foo bar');
  });

  it('POST /recipients/comment allows an empty comment', async () => {
    const sess = sessionEnv();
    const app = createServer({
      env: sess,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'comment=',
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const live = JSON.parse(readFileSync(join(sess.STATE_DIR, 'recipients.json'), 'utf8')) as {
      comment: string;
    };
    expect(live.comment).toBe('');
  });

  it('POST /recipients/comment rejects a missing comment field without writing', async () => {
    const sess = sessionEnv();
    const app = createServer({
      env: sess,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: '',
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Invalid comment');
    const live = JSON.parse(readFileSync(join(sess.STATE_DIR, 'recipients.json'), 'utf8')) as {
      comment: string;
    };
    expect(live.comment).toBe('21gifts daily');
  });

  it('POST /recipients/comment rejects a 501-character comment without writing', async () => {
    const sess = sessionEnv();
    const app = createServer({
      env: sess,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    const tooLong = 'x'.repeat(501);
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: `comment=${tooLong}`,
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Invalid comment');
    expect(html).toContain(tooLong);
    const live = JSON.parse(readFileSync(join(sess.STATE_DIR, 'recipients.json'), 'utf8')) as {
      comment: string;
      recipients: Array<{ address: string }>;
    };
    expect(live.comment).toBe('21gifts daily');
    expect(live.recipients).toEqual([{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }]);
  });

  it('unauthenticated POST /recipients/comment redirects to /', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'comment=hello+gifts',
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });

  it('POST /recipients/comment without Origin is 403', async () => {
    const app = createServer({
      env: sessionEnv(),
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const headers = new Headers();
    headers.set('host', '127.0.0.1');
    headers.set('content-type', 'application/x-www-form-urlencoded');
    headers.set('cookie', `spend_session=${token}`);
    const res = await app.fetch(
      new Request('http://127.0.0.1/recipients/comment', {
        method: 'POST',
        headers,
        body: 'comment=hello+gifts',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('POST /recipients/comment is 503 when the password is unset', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      req('http://127.0.0.1/recipients/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'comment=hello+gifts',
      }),
    );
    expect(res.status).toBe(503);
  });

  it('add, update, and delete preserve the file comment', async () => {
    const sess = sessionEnv();
    const app = createServer({
      env: sess,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const token = await login(app);
    const cookie = `spend_session=${token}`;
    await app.fetch(
      req('http://127.0.0.1/recipients/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'comment=hello+gifts',
      }),
    );
    await app.fetch(
      req('http://127.0.0.1/recipients/add', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=bob@walletofsatoshi.com&amountUsd=2',
      }),
    );
    expect(
      (JSON.parse(readFileSync(join(sess.STATE_DIR, 'recipients.json'), 'utf8')) as { comment: string })
        .comment,
    ).toBe('hello gifts');
    await app.fetch(
      req('http://127.0.0.1/recipients/update', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=bob@walletofsatoshi.com&amountUsd=3',
      }),
    );
    expect(
      (JSON.parse(readFileSync(join(sess.STATE_DIR, 'recipients.json'), 'utf8')) as { comment: string })
        .comment,
    ).toBe('hello gifts');
    await app.fetch(
      req('http://127.0.0.1/recipients/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: 'address=bob@walletofsatoshi.com',
      }),
    );
    const live = JSON.parse(readFileSync(join(sess.STATE_DIR, 'recipients.json'), 'utf8')) as {
      comment: string;
      recipients: Array<{ address: string }>;
    };
    expect(live.comment).toBe('hello gifts');
    expect(live.recipients).toEqual([{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }]);
  });
});

describe('GET /debug/recipients', () => {
  it('is 503 when DEBUG_TOKEN is unset', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/debug/recipients'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('boots and is 503 when DEBUG_TOKEN is empty', async () => {
    const app = createServer({
      env: { ...env, DEBUG_TOKEN: '' },
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/debug/recipients'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('is 401 when the token is set but the header is missing', async () => {
    const app = createServer({
      env: { ...sessionEnv(), DEBUG_TOKEN: 'secret-debug' },
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/debug/recipients'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('is 401 when the token is set but the bearer is wrong', async () => {
    const app = createServer({
      env: { ...sessionEnv(), DEBUG_TOKEN: 'secret-debug' },
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      req('http://127.0.0.1/debug/recipients', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns the live comment and roster without a session cookie', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: { ...sessionEnv(), DEBUG_TOKEN: 'secret-debug' },
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      req('http://127.0.0.1/debug/recipients', {
        headers: { authorization: 'Bearer secret-debug' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      comment: '21gifts daily',
      recipients: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
    });
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('spend.debug.recipients');
    expect(logged).toContain('"count":1');
    expect(logged).not.toContain('21gifts daily');
    expect(logged).not.toContain('secret-debug');
    expect(logged).not.toContain('alice@walletofsatoshi.com');
    warn.mockRestore();
  });

  it('HEAD with a matching Bearer is 200 with an empty JSON body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createServer({
      env: { ...sessionEnv(), DEBUG_TOKEN: 'secret-debug' },
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(
      req('http://127.0.0.1/debug/recipients', {
        method: 'HEAD',
        headers: { authorization: 'Bearer secret-debug' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    warn.mockRestore();
  });

  it('is 500 when the live file is corrupt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-debug-bad-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    const app = createServer({
      env: {
        ...env,
        STATE_DIR: dir,
        RECIPIENTS_FILE: seed,
        DEBUG_TOKEN: 'secret-debug',
      },
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    writeFileSync(join(dir, 'recipients.json'), '{');
    const res = await app.fetch(
      req('http://127.0.0.1/debug/recipients', {
        headers: { authorization: 'Bearer secret-debug' },
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Recipient list is unreadable' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('HEAD is 503 with an empty body when the token is unset', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(req('http://127.0.0.1/debug/recipients', { method: 'HEAD' }));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('');
  });
});
