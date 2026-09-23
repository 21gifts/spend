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

  it('isFundingEligible returns true', async () => {
    let seenUrl = '';
    let auth = '';
    const api = new GiftsApi('https://api.21.gifts', 'tok', async (url, init) => {
      seenUrl = String(url);
      auth = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({ eligible: true }), { status: 200 });
    });
    await expect(api.isFundingEligible('a@b.com')).resolves.toBe(true);
    expect(seenUrl).toBe('https://api.21.gifts/invoices/eligible?address=a%40b.com');
    expect(auth).toBe('Bearer tok');
  });

  it('isFundingEligible returns false', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ eligible: false }), { status: 200 }),
    );
    await expect(api.isFundingEligible('a@b.com')).resolves.toBe(false);
  });

  it('isFundingEligible throws on 503', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
    );
    await expect(api.isFundingEligible('a@b.com')).rejects.toMatchObject({ status: 503 });
  });

  it('isFundingEligible maps network failure to status 0', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      throw new Error('offline');
    });
    await expect(api.isFundingEligible('a@b.com')).rejects.toMatchObject({ status: 0 });
  });

  it('isFundingEligible rejects a malformed 200 body', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => new Response('{}', { status: 200 }));
    await expect(api.isFundingEligible('a@b.com')).rejects.toMatchObject({
      status: 0,
      message: 'malformed eligible response',
    });
  });

  it('fundingGrantStatus returns admitted', async () => {
    let seenUrl = '';
    let auth = '';
    const api = new GiftsApi('https://api.21.gifts', 'tok', async (url, init) => {
      seenUrl = String(url);
      auth = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({ eligible: true, status: 'admitted' }), { status: 200 });
    });
    await expect(api.fundingGrantStatus('a@b.com')).resolves.toBe('admitted');
    expect(seenUrl).toBe('https://api.21.gifts/invoices/eligible?address=a%40b.com');
    expect(auth).toBe('Bearer tok');
  });

  it('fundingGrantStatus returns none', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ status: 'none' }), { status: 200 }),
    );
    await expect(api.fundingGrantStatus('a@b.com')).resolves.toBe('none');
  });

  it('fundingGrantStatus rejects a malformed status as status 0', async () => {
    const payloads: unknown[] = [{}, { eligible: true }, { status: 'nope' }, { status: 1 }];
    for (const payload of payloads) {
      const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
        new Response(JSON.stringify(payload), { status: 200 }),
      );
      await expect(api.fundingGrantStatus('a@b.com')).rejects.toMatchObject({
        status: 0,
        message: 'malformed eligible status',
      });
    }
  });

  it('hasPosted returns true', async () => {
    let seenUrl = '';
    let auth = '';
    const api = new GiftsApi('https://api.21.gifts', 'tok', async (url, init) => {
      seenUrl = String(url);
      auth = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({ hasPosted: true }), { status: 200 });
    });
    await expect(api.hasPosted('a@b.com')).resolves.toEqual({
      hasPosted: true,
      hasMedia: false,
      messageId: null,
      postedAt: null,
    });
    expect(seenUrl).toBe('https://api.21.gifts/invoices/posted?address=a%40b.com');
    expect(auth).toBe('Bearer tok');
  });

  it('hasPosted returns false', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ hasPosted: false }), { status: 200 }),
    );
    await expect(api.hasPosted('a@b.com')).resolves.toEqual({
      hasPosted: false,
      hasMedia: false,
      messageId: null,
      postedAt: null,
    });
  });

  it('hasPosted returns hasMedia true', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ hasPosted: true, hasMedia: true }), { status: 200 }),
    );
    await expect(api.hasPosted('a@b.com')).resolves.toEqual({
      hasPosted: true,
      hasMedia: true,
      messageId: null,
      postedAt: null,
    });
  });

  it('hasPosted returns hasMedia false', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ hasPosted: true, hasMedia: false }), { status: 200 }),
    );
    await expect(api.hasPosted('a@b.com')).resolves.toEqual({
      hasPosted: true,
      hasMedia: false,
      messageId: null,
      postedAt: null,
    });
  });

  it('hasPosted returns hasMedia false for missing / non-boolean JSON', async () => {
    const payloads: unknown[] = [
      { hasPosted: true },
      { hasPosted: true, hasMedia: null },
      { hasPosted: true, hasMedia: 1 },
      { hasPosted: true, hasMedia: 'yes' },
      { hasPosted: true, hasMedia: {} },
    ];
    for (const payload of payloads) {
      const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
        new Response(JSON.stringify(payload), { status: 200 }),
      );
      await expect(api.hasPosted('a@b.com')).resolves.toEqual({
        hasPosted: true,
        hasMedia: false,
        messageId: null,
        postedAt: null,
      });
    }
  });

  it('hasPosted returns messageId when the JSON includes a valid UUID', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(
        JSON.stringify({ hasPosted: true, messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
        { status: 200 },
      ),
    );
    await expect(api.hasPosted('a@b.com')).resolves.toEqual({
      hasPosted: true,
      hasMedia: false,
      messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      postedAt: null,
    });
  });

  it('hasPosted returns messageId: null for missing / non-string / invalid uuid', async () => {
    const payloads: unknown[] = [
      { hasPosted: true },
      { hasPosted: true, messageId: 1 },
      { hasPosted: true, messageId: null },
      { hasPosted: true, messageId: '' },
      { hasPosted: true, messageId: 'nope' },
      { hasPosted: true, messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa' },
    ];
    for (const payload of payloads) {
      const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
        new Response(JSON.stringify(payload), { status: 200 }),
      );
      await expect(api.hasPosted('a@b.com')).resolves.toEqual({
        hasPosted: true,
        hasMedia: false,
        messageId: null,
        postedAt: null,
      });
    }
  });

  it('hasPosted returns postedAt when the JSON includes a parseable instant', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(
        JSON.stringify({
          hasPosted: true,
          messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          postedAt: '2026-08-23T12:00:00.000Z',
        }),
        { status: 200 },
      ),
    );
    await expect(api.hasPosted('a@b.com')).resolves.toEqual({
      hasPosted: true,
      hasMedia: false,
      messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      postedAt: '2026-08-23T12:00:00.000Z',
    });
  });

  it('createInvoice JSON includes messageId when the 4th argument is passed', async () => {
    let sent: unknown;
    const api = new GiftsApi('https://api.21.gifts', 'tok', async (_url, init) => {
      sent = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ id: '1', pr: 'lnbc1', paymentHash: 'aa'.repeat(32), amountMsat: 1000 }),
        { status: 200 },
      );
    });
    await api.createInvoice('a@b.com', 1000, 'hi', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(sent).toEqual({
      address: 'a@b.com',
      amountMsat: 1000,
      comment: 'hi',
      messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
  });

  it('createInvoice JSON omits messageId when it is not passed', async () => {
    let sent: unknown;
    const api = new GiftsApi('https://api.21.gifts', 'tok', async (_url, init) => {
      sent = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ id: '1', pr: 'lnbc1', paymentHash: 'aa'.repeat(32), amountMsat: 1000 }),
        { status: 200 },
      );
    });
    await api.createInvoice('a@b.com', 1000, 'hi');
    expect(sent).toEqual({
      address: 'a@b.com',
      amountMsat: 1000,
      comment: 'hi',
    });
    expect(sent).not.toHaveProperty('messageId');
    expect(sent).not.toHaveProperty('groupMessageId');
  });

  it('createInvoice JSON includes groupMessageId when the 5th argument is passed', async () => {
    let sent: unknown;
    const api = new GiftsApi('https://api.21.gifts', 'tok', async (_url, init) => {
      sent = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ id: '1', pr: 'lnbc1', paymentHash: 'aa'.repeat(32), amountMsat: 1000 }),
        { status: 200 },
      );
    });
    await api.createInvoice(
      'a@b.com',
      1000,
      'hi',
      undefined,
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    );
    expect(sent).toEqual({
      address: 'a@b.com',
      amountMsat: 1000,
      comment: 'hi',
      groupMessageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    expect(sent).not.toHaveProperty('messageId');
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
