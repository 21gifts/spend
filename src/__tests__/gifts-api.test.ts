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
    const inv = await api.createInvoice('a@b.com', 1000, '1.00', 'hi');
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
    const inv = await api.createInvoice('a@b.com', 1000, '1.00');
    expect(inv.paymentHash).toBe('aa'.repeat(32));
  });

  it('throws GiftsApiError on 401', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );
    await expect(api.createInvoice('a@b.com', 1000, '1.00')).rejects.toMatchObject({ status: 401 });
  });

  it('maps network failure to status 0', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      throw new Error('offline');
    });
    await expect(api.submitProof('1', '11'.repeat(32))).rejects.toBeInstanceOf(GiftsApiError);
  });

  it('rejects a malformed 200 body', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => new Response('{}', { status: 200 }));
    await expect(api.createInvoice('a@b.com', 1000, '1.00')).rejects.toMatchObject({ status: 0 });
  });

  it('rejects a malformed paymentHash as status 0', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(
        JSON.stringify({ id: '1', pr: 'lnbc1', paymentHash: 'zz', amountMsat: 1000 }),
        { status: 200 },
      ),
    );
    await expect(api.createInvoice('a@b.com', 1000, '1.00')).rejects.toMatchObject({ status: 0 });
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

  it('createInvoice JSON includes messageId when the 5th argument is passed', async () => {
    let sent: unknown;
    const api = new GiftsApi('https://api.21.gifts', 'tok', async (_url, init) => {
      sent = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ id: '1', pr: 'lnbc1', paymentHash: 'aa'.repeat(32), amountMsat: 1000 }),
        { status: 200 },
      );
    });
    await api.createInvoice('a@b.com', 1000, '5.00', 'hi', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(sent).toEqual({
      address: 'a@b.com',
      amountMsat: 1000,
      amountUsd: '5.00',
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
    await api.createInvoice('a@b.com', 1000, '5.00', 'hi');
    expect(sent).toEqual({
      address: 'a@b.com',
      amountMsat: 1000,
      amountUsd: '5.00',
      comment: 'hi',
    });
    expect(sent).not.toHaveProperty('messageId');
    expect(sent).not.toHaveProperty('groupMessageId');
  });

  it('createInvoice JSON includes groupMessageId when the 6th argument is passed', async () => {
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
      '5.00',
      'hi',
      undefined,
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    );
    expect(sent).toEqual({
      address: 'a@b.com',
      amountMsat: 1000,
      amountUsd: '5.00',
      comment: 'hi',
      groupMessageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    expect(sent).not.toHaveProperty('messageId');
  });

  it('dailyInstruction accepts every skip reason', async () => {
    const reasons = [
      'no_passkey',
      'no_post',
      'no_media',
      'not_eligible',
      'payments_disabled',
      'not_listed',
      'undecided',
      'welcome_paid',
    ] as const;
    for (const reason of reasons) {
      let seenUrl = '';
      let auth = '';
      let sent: unknown;
      const api = new GiftsApi('https://api.21.gifts', 'tok', async (url, init) => {
        seenUrl = String(url);
        auth = new Headers(init?.headers).get('authorization') ?? '';
        sent = JSON.parse(String(init?.body ?? '{}'));
        return new Response(JSON.stringify({ action: 'skip', reason }), { status: 200 });
      });
      await expect(api.dailyInstruction('a@b.com')).resolves.toEqual({ action: 'skip', reason });
      expect(seenUrl).toBe('https://api.21.gifts/spend/daily-instruction');
      expect(auth).toBe('Bearer tok');
      expect(sent).toEqual({ address: 'a@b.com' });
    }
  });

  it('dailyInstruction rejects an unknown skip reason', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ action: 'skip', reason: 'nope' }), { status: 200 }),
    );
    await expect(api.dailyInstruction('a@b.com')).rejects.toMatchObject({
      status: 0,
      message: 'malformed daily instruction',
    });
  });

  it('dailyInstruction returns pay with a non-empty messageId', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(
        JSON.stringify({
          action: 'pay',
          amountUsd: 1.5,
          comment: 'daily',
          messageId: 'not-a-uuid-but-kept',
        }),
        { status: 200 },
      ),
    );
    await expect(api.dailyInstruction('a@b.com')).resolves.toEqual({
      action: 'pay',
      amountUsd: 1.5,
      comment: 'daily',
      messageId: 'not-a-uuid-but-kept',
    });
  });

  it('dailyInstruction returns pay without messageId', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ action: 'pay', amountUsd: 1, comment: 'daily' }), {
        status: 200,
      }),
    );
    const result = await api.dailyInstruction('a@b.com');
    expect(result).toEqual({ action: 'pay', amountUsd: 1, comment: 'daily' });
    expect(result).not.toHaveProperty('messageId');
  });

  it('dailyInstruction omits messageId when it is empty', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(
        JSON.stringify({ action: 'pay', amountUsd: 1, comment: 'daily', messageId: '' }),
        { status: 200 },
      ),
    );
    const result = await api.dailyInstruction('a@b.com');
    expect(result).toEqual({ action: 'pay', amountUsd: 1, comment: 'daily' });
    expect(result).not.toHaveProperty('messageId');
  });

  it('dailyInstruction rejects a malformed action', async () => {
    const payloads: unknown[] = [
      {},
      { action: 'hold' },
      { action: 'Skip', reason: 'no_passkey' },
      { action: 1 },
    ];
    for (const payload of payloads) {
      const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
        new Response(JSON.stringify(payload), { status: 200 }),
      );
      await expect(api.dailyInstruction('a@b.com')).rejects.toMatchObject({
        status: 0,
        message: 'malformed daily instruction',
      });
    }
  });

  it('dailyInstruction rejects a non-finite or non-positive amountUsd', async () => {
    const amounts: unknown[] = [0, -1, NaN, Infinity, '1', null];
    for (const amountUsd of amounts) {
      const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
        new Response(JSON.stringify({ action: 'pay', amountUsd, comment: 'daily' }), {
          status: 200,
        }),
      );
      await expect(api.dailyInstruction('a@b.com')).rejects.toMatchObject({
        status: 0,
        message: 'malformed daily instruction',
      });
    }
  });

  it('dailyInstruction rejects a non-string comment', async () => {
    const comments: unknown[] = [1, null, undefined, true, {}];
    for (const comment of comments) {
      const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
        new Response(JSON.stringify({ action: 'pay', amountUsd: 1, comment }), { status: 200 }),
      );
      await expect(api.dailyInstruction('a@b.com')).rejects.toMatchObject({
        status: 0,
        message: 'malformed daily instruction',
      });
    }
  });

  it('dailyInstruction rejects a non-string messageId', async () => {
    const ids: unknown[] = [1, null, true, {}];
    for (const messageId of ids) {
      const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
        new Response(
          JSON.stringify({ action: 'pay', amountUsd: 1, comment: 'daily', messageId }),
          { status: 200 },
        ),
      );
      await expect(api.dailyInstruction('a@b.com')).rejects.toMatchObject({
        status: 0,
        message: 'malformed daily instruction',
      });
    }
  });

  it('dailyInstruction throws on 503', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ error: 'Daily roster is not configured' }), { status: 503 }),
    );
    await expect(api.dailyInstruction('a@b.com')).rejects.toMatchObject({ status: 503 });
  });

  it('dailyInstruction maps network failure to status 0', async () => {
    const api = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      throw new Error('offline');
    });
    await expect(api.dailyInstruction('a@b.com')).rejects.toMatchObject({ status: 0 });
  });
});
