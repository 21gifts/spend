import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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

  it('passes SPEND_LIVE to the midnight run', async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const handle = app.startScheduler();
    await Promise.resolve();
    expect(runDay).toHaveBeenCalledWith(
      expect.anything(),
      { live: true, day: '2026-08-25' },
    );
    handle.stop();
  });

  it('defaults the midnight run to dry-run without SPEND_LIVE', async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const handle = app.startScheduler();
    await Promise.resolve();
    expect(runDay).toHaveBeenCalledWith(
      expect.anything(),
      { live: false, day: '2026-08-25' },
    );
    handle.stop();
  });

  it('startCatchup pays remaining live recipients outside midnight', async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-27T00:43:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const result = await app.startCatchup();
    expect(result).toEqual({ exitCode: 0 });
    expect(runDay).toHaveBeenCalledWith(expect.anything(), { live: true, day: '2026-08-27' });
  });

  it('startCatchup logs and returns null when payout throws', async () => {
    const runDay = vi.fn(async () => {
      throw new Error('boom');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-27T00:43:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    await expect(app.startCatchup()).resolves.toBeNull();
    expect(JSON.stringify(warn.mock.calls)).toContain('spend.catchup');
    expect(JSON.stringify(warn.mock.calls)).toContain('boom');
    warn.mockRestore();
  });

  it('drainPayouts waits for an in-flight catch-up', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runDay = vi.fn(async () => {
      await blocked;
      return { exitCode: 0 };
    });
    const app = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const catchup = app.startCatchup();
    const drained = app.drainPayouts();
    release();
    await expect(catchup).resolves.toEqual({ exitCode: 0 });
    await expect(drained).resolves.toBeUndefined();
  });

  it('startCatchup is a no-op without SPEND_LIVE', async () => {
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env,
      now: () => new Date('2026-08-27T00:43:00.000Z'),
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    await expect(app.startCatchup()).resolves.toBeNull();
    expect(runDay).not.toHaveBeenCalled();
  });

  it('startCatchup returns null without payout when the day JSONL has *halt* uncertain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-halt-catchup-'));
    writeFileSync(
      join(dir, '2026-08-27.jsonl'),
      `${JSON.stringify({
        ts: 't',
        address: '*halt*',
        invoiceId: '',
        paymentHash: '',
        status: 'uncertain',
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, SPEND_LIVE: 'true' },
        now: () => new Date('2026-08-27T12:00:00.000Z'),
        runDay,
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      await expect(app.startCatchup()).resolves.toBeNull();
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('startCatchup returns null without payout when a live recipient is uncertain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-recipient-uncertain-catchup-'));
    writeFileSync(
      join(dir, '2026-08-27.jsonl'),
      `${JSON.stringify({
        ts: 't',
        address: 'alice@walletofsatoshi.com',
        invoiceId: '',
        paymentHash: '',
        status: 'uncertain',
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, SPEND_LIVE: 'true' },
        now: () => new Date('2026-08-27T12:00:00.000Z'),
        runDay,
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      await expect(app.startCatchup()).resolves.toBeNull();
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('startCatchup returns null without payout when every live recipient already has a JSONL row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-failed-catchup-'));
    writeFileSync(
      join(dir, '2026-08-27.jsonl'),
      `${JSON.stringify({
        ts: 't',
        address: 'alice@walletofsatoshi.com',
        invoiceId: '',
        paymentHash: '',
        status: 'failed',
      })}\n`,
    );
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, SPEND_LIVE: 'true' },
        now: () => new Date('2026-08-27T12:00:00.000Z'),
        runDay,
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      await expect(app.startCatchup()).resolves.toBeNull();
      expect(runDay).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('startCatchup falls through to payout when the day JSONL is corrupt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-corrupt-catchup-'));
    writeFileSync(join(dir, '2026-08-27.jsonl'), 'not-json\n');
    const runDay = vi.fn(async () => ({ exitCode: 4 }));
    try {
      const app = createServer({
        env: { ...env, STATE_DIR: dir, SPEND_LIVE: 'true' },
        now: () => new Date('2026-08-27T12:00:00.000Z'),
        runDay,
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      await expect(app.startCatchup()).resolves.toEqual({ exitCode: 4 });
      expect(runDay).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('startRetryCatchup invokes catch-up on the interval when live', async () => {
    vi.useFakeTimers();
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env: { ...env, SPEND_LIVE: 'true' },
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      retryCatchupMs: 20,
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const handle = app.startRetryCatchup();
    expect(runDay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    expect(runDay).toHaveBeenCalled();
    handle.stop();
  });

  it('startRetryCatchup is a no-op without SPEND_LIVE', async () => {
    vi.useFakeTimers();
    const runDay = vi.fn(async () => ({ exitCode: 0 }));
    const app = createServer({
      env,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      retryCatchupMs: 20,
      runDay,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const handle = app.startRetryCatchup();
    await vi.advanceTimersByTimeAsync(20);
    expect(runDay).not.toHaveBeenCalled();
    handle.stop();
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

  it('scheduler notifies Telegram after payout when configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
        const path = String(url);
        if (path.includes('api.telegram.org')) {
          telegramCalls.push(path);
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });
    const handle = app.startScheduler();
    await vi.waitFor(() => {
      expect(telegramCalls.length).toBe(1);
    });
    expect(telegramCalls[0]).toContain('api.telegram.org/bot');
    const warnPayload = JSON.stringify(warn.mock.calls);
    expect(warnPayload).toContain('spend.telegram');
    expect(warnPayload).not.toContain('123456:AA-testtoken_notreal_xxxxxx');
    handle.stop();
    warn.mockRestore();
  });

  it('catch-up does not notify Telegram on a pure all-skip success', async () => {
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
    await expect(app.startCatchup()).resolves.toEqual({ exitCode: 0 });
    expect(telegramCalls).toEqual([]);
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
    await expect(app.startCatchup()).resolves.toEqual({ exitCode: 4 });
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(0);
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('notifies Telegram once when catch-up alone hits corrupt recipients', async () => {
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
    await expect(app.startCatchup()).resolves.toEqual({ exitCode: 4 });
    expect(runDay).not.toHaveBeenCalled();
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      text: expect.stringContaining('corrupt_recipients'),
    });
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dedupes catch-up insufficient_balance Telegram until a paid run', async () => {
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
    await expect(app.startCatchup()).resolves.toEqual({ exitCode: 3 });
    await expect(app.startCatchup()).resolves.toEqual({ exitCode: 3 });
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      text: expect.stringContaining('insufficient_balance'),
    });
    await expect(app.startCatchup()).resolves.toEqual({ exitCode: 0 });
    expect(telegramBodies).toHaveLength(2);
    expect(telegramBodies[1]).toMatchObject({
      text: expect.stringContaining('a@b.com'),
    });
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

  it('dedupes catch-up usd_to_sats Telegram even when failed mirrors the preflight', async () => {
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
    await expect(app.startCatchup()).resolves.toEqual({ exitCode: 3 });
    await expect(app.startCatchup()).resolves.toEqual({ exitCode: 3 });
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      text: expect.stringContaining('usd_to_sats'),
    });
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
});
