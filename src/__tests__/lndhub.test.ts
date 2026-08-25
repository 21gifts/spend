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

  it('reads a sats balance field without scaling', async () => {
    const client = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ balance: 1500 }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const token = await client.auth();
    expect(await client.balance(token)).toBe(1500);
  });

  it('returns the payment preimage', async () => {
    const client = new LndhubClient(target, async () =>
      new Response(JSON.stringify({ payment_preimage: '11'.repeat(32) }), { status: 200 }),
    );
    expect(await client.payInvoice('tok', 'lnbc1')).toEqual({ preimage: '11'.repeat(32) });
  });

  it('returns null preimage when missing', async () => {
    const client = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/payinvoice')) {
        return new Response('{}', { status: 200 });
      }
      if (String(url).endsWith('/gettxs')) {
        return new Response('[]', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    expect(await client.payInvoice('tok', 'lnbc1')).toEqual({ preimage: null });
  });

  it('looks up a non-zero preimage on gettxs when payinvoice returns zeros', async () => {
    const real = 'ab'.repeat(32);
    const hash = 'cd'.repeat(32);
    const client = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/payinvoice')) {
        return new Response(
          JSON.stringify({
            payment_preimage: '0'.repeat(64),
            payment_hash: hash,
            type: 'paid_invoice',
          }),
          { status: 201 },
        );
      }
      if (String(url).endsWith('/gettxs')) {
        return new Response(
          JSON.stringify([{ payment_hash: hash.toUpperCase(), payment_preimage: real, value: -23 }]),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    expect(await client.payInvoice('tok', 'lnbc1')).toEqual({ preimage: real });
  });

  it('returns the first getbtc address', async () => {
    const client = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/getbtc')) {
        return new Response(JSON.stringify([{ address: 'bc1qtestaddress0001' }]), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    expect(await client.getDepositAddress('tok')).toBe('bc1qtestaddress0001');
  });

  it('creates an address via newbtc when getbtc is empty', async () => {
    const client = new LndhubClient(target, async (url, init) => {
      if (String(url).endsWith('/getbtc')) {
        return new Response('[]', { status: 200 });
      }
      if (String(url).endsWith('/newbtc')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ address: 'bc1qnewfromhub' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    expect(await client.getDepositAddress('tok')).toBe('bc1qnewfromhub');
  });

  it('returns null when no deposit address exists', async () => {
    const client = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/getbtc')) {
        return new Response('[]', { status: 200 });
      }
      if (String(url).endsWith('/newbtc')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    expect(await client.getDepositAddress('tok')).toBeNull();
  });
});
