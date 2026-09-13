import { describe, it, expect } from 'vitest';
import { GiftsApi, GiftsApiError } from '../gifts-api';

describe('GiftsApi', () => {
  it('creates an invoice', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(
        JSON.stringify({ id: '1', pr: 'lnbc1', paymentHash: 'aa'.repeat(32), amountMsat: 1000 }),
        { status: 200 },
      ),
    );
    const inv = await api.createInvoice('a@b.com', 1000, 'hi');
    expect(inv.id).toBe('1');
  });

  it('normalises an uppercase paymentHash', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(
        JSON.stringify({
          id: '1',
          pr: 'lnbc1',
          paymentHash: 'AA'.repeat(32),
          amountMsat: 1000,
        }),
        { status: 200 },
      ),
    );
    const inv = await api.createInvoice('a@b.com', 1000);
    expect(inv.paymentHash).toBe('aa'.repeat(32));
  });

  it('throws GiftsApiError on 401', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );
    await expect(api.createInvoice('a@b.com', 1000)).rejects.toMatchObject({ status: 401 });
  });

  it('maps network failure to status 0', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      throw new Error('offline');
    });
    await expect(api.submitProof('1', '11'.repeat(32))).rejects.toBeInstanceOf(GiftsApiError);
  });

  it('rejects a malformed 200 body', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => new Response('{}', { status: 200 }));
    await expect(api.createInvoice('a@b.com', 1000)).rejects.toMatchObject({ status: 0 });
  });

  it('rejects a malformed paymentHash as status 0', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(
        JSON.stringify({ id: '1', pr: 'lnbc1', paymentHash: 'zz', amountMsat: 1000 }),
        { status: 200 },
      ),
    );
    await expect(api.createInvoice('a@b.com', 1000)).rejects.toMatchObject({ status: 0 });
  });

  it('hasPasskey returns true', async () => {
    let seenUrl = '';
    let auth = '';
    const api = new GiftsApi('https://api.21.gifts', 'tok', async (url, init) => {
      seenUrl = String(url);
      auth = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({ hasPasskey: true }), { status: 200 });
    });
    await expect(api.hasPasskey('a@b.com')).resolves.toBe(true);
    expect(seenUrl).toBe('https://api.21.gifts/invoices/passkey?address=a%40b.com');
    expect(auth).toBe('Bearer tok');
  });

  it('hasPasskey returns false', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ hasPasskey: false }), { status: 200 }),
    );
    await expect(api.hasPasskey('a@b.com')).resolves.toBe(false);
  });

  it('hasPasskey throws on 503', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
    );
    await expect(api.hasPasskey('a@b.com')).rejects.toMatchObject({ status: 503 });
  });

  it('hasPasskey maps network failure to status 0', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      throw new Error('offline');
    });
    await expect(api.hasPasskey('a@b.com')).rejects.toMatchObject({ status: 0 });
  });

  it('hasPosted returns true', async () => {
    let seenUrl = '';
    let auth = '';
    const api = new GiftsApi('https://api.21.gifts', 'tok', async (url, init) => {
      seenUrl = String(url);
      auth = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({ hasPosted: true }), { status: 200 });
    });
    await expect(api.hasPosted('a@b.com')).resolves.toBe(true);
    expect(seenUrl).toBe('https://api.21.gifts/invoices/posted?address=a%40b.com');
    expect(auth).toBe('Bearer tok');
  });

  it('hasPosted returns false', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ hasPosted: false }), { status: 200 }),
    );
    await expect(api.hasPosted('a@b.com')).resolves.toBe(false);
  });

  it('hasPosted throws on 503', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
    );
    await expect(api.hasPosted('a@b.com')).rejects.toMatchObject({ status: 503 });
  });

  it('hasPosted maps network failure to status 0', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      throw new Error('offline');
    });
    await expect(api.hasPosted('a@b.com')).rejects.toMatchObject({ status: 0 });
  });

  it('hasPosted rejects a malformed 200 body', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => new Response('{}', { status: 200 }));
    await expect(api.hasPosted('a@b.com')).rejects.toMatchObject({
      status: 0,
      message: 'malformed posted response',
    });
  });
});
