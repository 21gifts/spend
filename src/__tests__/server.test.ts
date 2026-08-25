import { describe, it, expect } from 'vitest';
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

  it('renders sats on GET /', async () => {
    const app = createServer({
      env,
      fetchImpl: async (url) => {
        const path = String(url);
        if (path.endsWith('/auth')) {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
        }
        if (path.endsWith('/balance')) {
          return new Response(JSON.stringify({ BTC: { AvailableBalance: 3803 } }), { status: 200 });
        }
        if (path.endsWith('/getbtc')) {
          return new Response(JSON.stringify([{ address: 'bc1qdashboardaddr' }]), { status: 200 });
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
    expect(html).toContain('bc1qdashboardaddr');
    expect(html).toContain('<svg');
  });
});
