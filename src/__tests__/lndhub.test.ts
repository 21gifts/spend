import { describe, it, expect } from 'vitest';
import { LndhubClient, parseLndhubUri } from '../lndhub';

describe('parseLndhubUri', () => {
  it('parses login, password, and https base', () => {
    expect(parseLndhubUri('lndhub://admin:secret@https://lightning.space/lndhub')).toEqual({
      login: 'admin',
      password: 'secret',
      baseUrl: 'https://lightning.space/lndhub',
    });
  });

  it('rejects a non-lndhub URI', () => {
    expect(parseLndhubUri('https://lightning.space')).toBeNull();
  });
});

describe('LndhubClient', () => {
  const target = parseLndhubUri('lndhub://admin:secret@https://lightning.space/lndhub');
  if (target === null) {
    throw new Error('fixture');
  }

  it('reads access_token and AvailableBalance', async () => {
    const client = new LndhubClient(target, async (url, init) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 5000 } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const token = await client.auth();
    expect(token).toBe('tok');
    expect(await client.balance(token)).toBe(5000);
  });

  it('returns the payment preimage', async () => {
    const client = new LndhubClient(target, async () =>
      new Response(JSON.stringify({ payment_preimage: '11'.repeat(32) }), { status: 200 }),
    );
    expect(await client.payInvoice('tok', 'lnbc1')).toEqual({ preimage: '11'.repeat(32) });
  });

  it('returns null preimage when missing', async () => {
    const client = new LndhubClient(target, async () => new Response('{}', { status: 200 }));
    expect(await client.payInvoice('tok', 'lnbc1')).toEqual({ preimage: null });
  });
});
