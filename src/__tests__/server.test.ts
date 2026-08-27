import { describe, it, expect, vi } from 'vitest';
import { createServer, parseBindAddr } from '../server';

const env = {
  GIFTS_API_URL: 'http://api.example',
  GIFTS_API_TOKEN: 'tok',
  LNDHUB_URI: 'lndhub://admin:secret@https://lightning.space/lndhub',
  RECIPIENTS_FILE: './recipients.example.json',
};

describe('parseBindAddr', () => {
  it('parses host and port', () => {
    expect(parseBindAddr('0.0.0.0:3000')).toEqual({ hostname: '0.0.0.0', port: 3000 });
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
    const res = await app.fetch(new Request('http://127.0.0.1/nope'));
    expect(res.status).toBe(404);
  });

  it('serves healthz without LNDHub I/O', async () => {
    const app = createServer({
      env,
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(new Request('http://127.0.0.1/healthz'));
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
    const res = await app.fetch(new Request('http://127.0.0.1/healthz', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('renders sats on GET /', async () => {
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
    const res = await app.fetch(new Request('http://127.0.0.1/'));
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
  });

  it('HEAD / is 200 with empty body and does not load the dashboard', async () => {
    const app = createServer({
      env: { ...env, SPEND_LIGHTNING_ADDRESS: '9643e3@lightning.space' },
      fetchImpl: async () => {
        throw new Error('no network');
      },
    });
    const res = await app.fetch(new Request('http://127.0.0.1/', { method: 'HEAD' }));
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
});
