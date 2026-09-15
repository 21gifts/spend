import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { SpendConfig } from '../config';
import { GiftsApi } from '../gifts-api';
import { LndhubClient, parseLndhubUri } from '../lndhub';
import { runDay } from '../run';
import { DayState } from '../state';

const PREIMAGE = '11'.repeat(32);
const HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');

const config: SpendConfig = {
  giftsApiUrl: 'https://api.21.gifts',
  giftsApiToken: 'tok',
  lndhubUri: 'lndhub://admin:key@https://lightning.space/lndhub',
  recipientsFile: 'r.json',
  stateDir: '/tmp',
  comment: '21gifts daily',
  lightningAddress: null,
  dashboardPassword: null,
  recipients: [
    { address: 'a@b.com', amountUsd: 1 },
    { address: 'c@d.com', amountUsd: 0.5 },
  ],
};

const target = parseLndhubUri(config.lndhubUri);
if (target === null) {
  throw new Error('fixture');
}

/**
 * Answer GET /invoices/passkey with `{ hasPasskey: true }` and GET
 * /invoices/posted with `{ hasPosted: true }` by default so existing
 * POST /invoices mocks keep working. Override via `passkeyByAddress` /
 * `postedByAddress` when needed.
 */
function giftsFetch(
  postHandler: (url: string, init?: RequestInit) => Promise<Response>,
  passkeyByAddress?: Record<string, boolean | 'throw' | number>,
  postedByAddress?: Record<string, boolean | 'throw' | number>,
): typeof fetch {
  return async (url, init) => {
    const href = String(url);
    if (href.includes('/invoices/passkey')) {
      const address = new URL(href).searchParams.get('address') ?? '';
      const override = passkeyByAddress?.[address];
      if (override === 'throw') {
        throw new Error('passkey offline');
      }
      if (typeof override === 'number') {
        return new Response(JSON.stringify({ error: 'down' }), { status: override });
      }
      const hasPasskey = override === undefined ? true : override;
      return new Response(JSON.stringify({ hasPasskey }), { status: 200 });
    }
    if (href.includes('/invoices/posted')) {
      const address = new URL(href).searchParams.get('address') ?? '';
      const override = postedByAddress?.[address];
      if (override === 'throw') {
        throw new Error('posted offline');
      }
      if (typeof override === 'number') {
        return new Response(JSON.stringify({ error: 'down' }), { status: override });
      }
      const hasPosted = override === undefined ? true : override;
      return new Response(JSON.stringify({ hasPosted }), { status: 200 });
    }
    return postHandler(href, init);
  };
}

function memoryState(existing = ''): DayState {
  let file = existing;
  let finished = false;
  return new DayState('/tmp', '2026-08-23', {
    exists: (path) => (path.endsWith('.finished') ? finished : file !== ''),
    read: () => file,
    append: (path, data) => {
      if (path.endsWith('.finished')) {
        finished = true;
        return;
      }
      file += data;
    },
    mkdir: () => undefined,
  });
}

const openLock = {
  tryAcquire: () => true,
  release: () => undefined,
};

const heldLock = {
  tryAcquire: () => false,
  release: () => undefined,
};

describe('runDay', () => {
  it('dry-run invoice errors do not persist uncertain for a later live run', async () => {
    const failing = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => new Response(JSON.stringify({ error: 'down' }), { status: 503 })),
    );
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dry = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: false, day: '2026-08-23' },
      { gifts: failing, lndhub: new LndhubClient(target), state, lock: openLock, btcUsd: async () => 100_000 },
    );
    expect(dry.exitCode).toBe(3);
    expect(state.load().some((row) => row.status === 'uncertain')).toBe(false);
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async (url) => {
        if (url.endsWith('/proof')) {
          return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 1_000_000 }),
          { status: 200 },
        );
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const live = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state, lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(live.exitCode).toBe(0);
  });

  it('dry-run fetches invoices and does not pay', async () => {
    let paid = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { amountMsat?: number };
        return new Response(
          JSON.stringify({
            id: 'id1',
            pr: 'lnbc1abcdefghijklmnop',
            paymentHash: HASH,
            amountMsat: body.amountMsat ?? 1_000_000,
          }),
          { status: 200 },
        );
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      paid += 1;
      return new Response('{}', { status: 200 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: false, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state: memoryState(),
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(paid).toBe(0);
  });

  it('live pays then submits the preimage', async () => {
    let proofBody: unknown;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async (url, init) => {
        if (url.endsWith('/proof')) {
          proofBody = JSON.parse(String(init?.body ?? '{}'));
          return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 1_000_000 }),
          { status: 200 },
        );
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state, lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatchObject({
      day: '2026-08-23',
      live: true,
      ok: true,
      exitCode: 0,
      btcUsd: 100_000,
      paid: [{ address: 'a@b.com', amountSats: 1000, amountUsd: 1 }],
      skipped: [],
      failed: [],
      uncertain: [],
      dryRun: [],
    });
    expect(proofBody).toEqual({ id: 'id1', preimage: PREIMAGE });
    expect(state.isFinished()).toBe(true);
  });

  it('invoices only onlyAddresses and does not skip-log other roster members', async () => {
    const invoiced: string[] = [];
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(
        async (url, init) => {
          if (url.endsWith('/proof')) {
            return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
          }
          const body = JSON.parse(String(init?.body ?? '{}')) as { address?: string };
          if (typeof body.address === 'string') {
            invoiced.push(body.address);
          }
          return new Response(
            JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 1_000_000 }),
            { status: 200 },
          );
        },
        { 'bob@walletofsatoshi.com': 'throw' },
      ),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      {
        ...config,
        recipients: [
          { address: 'alice@walletofsatoshi.com', amountUsd: 1 },
          { address: 'bob@walletofsatoshi.com', amountUsd: 0.5 },
        ],
      },
      { live: true, day: '2026-08-23', onlyAddresses: ['alice@walletofsatoshi.com'] },
      { gifts, lndhub, state, lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(invoiced).toEqual(['alice@walletofsatoshi.com']);
    expect(result.summary.paid).toEqual([
      expect.objectContaining({ address: 'alice@walletofsatoshi.com' }),
    ]);
    expect(result.summary.skipped).toEqual([]);
    expect(state.load().some((row) => row.address === 'bob@walletofsatoshi.com')).toBe(false);
    expect(state.isFinished()).toBe(false);
  });

  it('forwards hasPosted messageId on the invoice POST body', async () => {
    let invoiceBody: unknown;
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async (url, init) => {
      const href = String(url);
      if (href.includes('/invoices/passkey')) {
        return new Response(JSON.stringify({ hasPasskey: true }), { status: 200 });
      }
      if (href.includes('/invoices/posted')) {
        return new Response(
          JSON.stringify({
            hasPosted: true,
            messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          }),
          { status: 200 },
        );
      }
      invoiceBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          id: 'id1',
          pr: 'lnbc1abcdefghijklmnop',
          paymentHash: HASH,
          amountMsat: 1_000_000,
        }),
        { status: 200 },
      );
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: false, day: '2026-08-23' },
      {
        gifts,
        lndhub: new LndhubClient(target),
        state: memoryState(),
        lock: openLock,
        btcUsd: async () => 100_000,
      },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(invoiceBody).toEqual({
      address: 'a@b.com',
      amountMsat: 1_000_000,
      comment: '21gifts daily',
      messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
  });

  it('forwards RunOptions.messageIdByAddress to createInvoice over posted id', async () => {
    let invoiceBody: unknown;
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async (url, init) => {
      const href = String(url);
      if (href.includes('/invoices/passkey')) {
        return new Response(JSON.stringify({ hasPasskey: true }), { status: 200 });
      }
      if (href.includes('/invoices/posted')) {
        return new Response(
          JSON.stringify({
            hasPosted: true,
            messageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          }),
          { status: 200 },
        );
      }
      invoiceBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          id: 'id1',
          pr: 'lnbc1abcdefghijklmnop',
          paymentHash: HASH,
          amountMsat: 1_000_000,
        }),
        { status: 200 },
      );
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      {
        live: false,
        day: '2026-08-23',
        messageIdByAddress: {
          'a@b.com': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
      },
      {
        gifts,
        lndhub: new LndhubClient(target),
        state: memoryState(),
        lock: openLock,
        btcUsd: async () => 100_000,
      },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(invoiceBody).toEqual({
      address: 'a@b.com',
      amountMsat: 1_000_000,
      comment: '21gifts daily',
      messageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
  });

  it('skips addresses already paid', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => {
        invoices += 1;
        return new Response('{}', { status: 500 });
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const paid = `${JSON.stringify({
      ts: 't',
      address: 'a@b.com',
      invoiceId: '1',
      paymentHash: HASH,
      status: 'paid',
    })}\n`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state: memoryState(paid), lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(invoices).toBe(0);
  });

  it('skips persisted failed recipients and pays the rest', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async (url) => {
        if (url.endsWith('/proof')) {
          return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
        }
        invoices += 1;
        return new Response(
          JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 500_000 }),
          { status: 200 },
        );
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const prior = `${JSON.stringify({
      ts: 't',
      address: 'a@b.com',
      invoiceId: '',
      paymentHash: '',
      status: 'failed',
    })}\n`;
    const state = memoryState(prior);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(invoices).toBe(1);
    expect(result.summary.skipped).toEqual([
      expect.objectContaining({ address: 'a@b.com', reason: 'failed' }),
    ]);
    expect(result.summary.paid).toEqual([
      expect.objectContaining({ address: 'c@d.com' }),
    ]);
    expect(state.isFinished()).toBe(true);
  });

  it('does not count persisted failed recipients in the balance preflight', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async (url) => {
        if (url.endsWith('/proof')) {
          return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
        }
        invoices += 1;
        return new Response(
          JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 500_000 }),
          { status: 200 },
        );
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 600 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const prior = `${JSON.stringify({
      ts: 't',
      address: 'a@b.com',
      invoiceId: '',
      paymentHash: '',
      status: 'failed',
    })}\n`;
    const state = memoryState(prior);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(result.summary.reason).not.toBe('insufficient_balance');
    expect(invoices).toBe(1);
    expect(result.summary.skipped).toEqual([
      expect.objectContaining({ address: 'a@b.com', reason: 'failed' }),
    ]);
    expect(result.summary.paid).toEqual([
      expect.objectContaining({ address: 'c@d.com' }),
    ]);
    expect(state.isFinished()).toBe(true);
  });

  it('skips no_passkey recipients, excludes them from needed, and leaves the day unfinished', async () => {
    let invoices = 0;
    let neededInPreflight: number | undefined;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(
        async (url) => {
          if (url.endsWith('/proof')) {
            return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
          }
          invoices += 1;
          return new Response(
            JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 500_000 }),
            { status: 200 },
          );
        },
        { 'a@b.com': false, 'c@d.com': true },
      ),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        // Only c@d.com (500 sats) must be needed; a@b.com (1000) is ineligible.
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 600 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation((msg) => {
      const line = typeof msg === 'string' ? msg : '';
      if (line.includes('"reason":"insufficient_balance"')) {
        const parsed = JSON.parse(line) as { needed?: number };
        neededInPreflight = parsed.needed;
      }
    });
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(result.summary.reason).toBeUndefined();
    expect(neededInPreflight).toBeUndefined();
    expect(invoices).toBe(1);
    expect(result.summary.skipped).toEqual([
      expect.objectContaining({ address: 'a@b.com', reason: 'no_passkey' }),
    ]);
    expect(result.summary.paid).toEqual([
      expect.objectContaining({ address: 'c@d.com' }),
    ]);
    expect(state.load().some((row) => row.address === 'a@b.com')).toBe(false);
    expect(state.isFinished()).toBe(false);
  });

  it('aborts with passkey_unreachable when the passkey lookup throws', async () => {
    let payCalls = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => new Response('{}', { status: 500 }), { 'a@b.com': 'throw' }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      payCalls += 1;
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state, lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
    expect(result.summary.reason).toBe('passkey_unreachable');
    expect(payCalls).toBe(0);
    expect(state.load()).toEqual([]);
    expect(state.isFinished()).toBe(false);
  });

  it('treats POST 403 Passkey required as no_passkey without persisting failed', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => {
        invoices += 1;
        return new Response(JSON.stringify({ error: 'Passkey required' }), { status: 403 });
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state, lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(invoices).toBe(1);
    expect(result.summary.reason).toBeUndefined();
    expect(result.summary.skipped).toEqual([
      expect.objectContaining({ address: 'a@b.com', reason: 'no_passkey' }),
    ]);
    expect(result.summary.failed).toEqual([]);
    expect(state.load().some((row) => row.status === 'failed')).toBe(false);
    expect(state.isFinished()).toBe(false);
  });

  it('skips no_post recipients, excludes them from needed, and leaves the day unfinished', async () => {
    let invoices = 0;
    let neededInPreflight: number | undefined;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(
        async (url) => {
          if (url.endsWith('/proof')) {
            return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
          }
          invoices += 1;
          return new Response(
            JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 500_000 }),
            { status: 200 },
          );
        },
        undefined,
        { 'a@b.com': false, 'c@d.com': true },
      ),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        // Only c@d.com (500 sats) must be needed; a@b.com (1000) is ineligible.
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 600 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation((msg) => {
      const line = typeof msg === 'string' ? msg : '';
      if (line.includes('"reason":"insufficient_balance"')) {
        const parsed = JSON.parse(line) as { needed?: number };
        neededInPreflight = parsed.needed;
      }
    });
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(result.summary.reason).toBeUndefined();
    expect(neededInPreflight).toBeUndefined();
    expect(invoices).toBe(1);
    expect(result.summary.skipped).toEqual([
      expect.objectContaining({ address: 'a@b.com', reason: 'no_post' }),
    ]);
    expect(result.summary.paid).toEqual([
      expect.objectContaining({ address: 'c@d.com' }),
    ]);
    expect(state.load().some((row) => row.address === 'a@b.com')).toBe(false);
    expect(state.isFinished()).toBe(false);
  });

  it('aborts with posted_unreachable when the posted lookup throws', async () => {
    let payCalls = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => new Response('{}', { status: 500 }), undefined, { 'a@b.com': 'throw' }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      payCalls += 1;
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state, lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
    expect(result.summary.reason).toBe('posted_unreachable');
    expect(payCalls).toBe(0);
    expect(state.load()).toEqual([]);
    expect(state.isFinished()).toBe(false);
  });

  it('treats POST 403 Forum post required as no_post without persisting failed', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => {
        invoices += 1;
        return new Response(JSON.stringify({ error: 'Forum post required' }), { status: 403 });
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state, lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(invoices).toBe(1);
    expect(result.summary.reason).toBeUndefined();
    expect(result.summary.skipped).toEqual([
      expect.objectContaining({ address: 'a@b.com', reason: 'no_post' }),
    ]);
    expect(result.summary.failed).toEqual([]);
    expect(state.load().some((row) => row.status === 'failed')).toBe(false);
    expect(state.isFinished()).toBe(false);
  });

  it('aborts on low balance', async () => {
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 10 } }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts: new GiftsApi(
        'https://api.21.gifts',
        'tok',
        giftsFetch(async () => new Response('{}', { status: 500 })),
      ),
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
    expect(result.summary).toMatchObject({
      day: '2026-08-23',
      live: true,
      ok: false,
      exitCode: 3,
      reason: 'insufficient_balance',
      btcUsd: 100_000,
      needed: expect.any(Number),
      available: 10,
    });
    expect(state.isFinished()).toBe(false);
  });

  it('treats gifts API 503 as invoice_unreachable and continues to the next recipient', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => {
        invoices += 1;
        return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
    expect(invoices).toBe(2);
    expect(state.load()).toEqual([]);
    expect(state.load().some((row) => row.status === 'uncertain')).toBe(false);
    expect(state.load().some((row) => row.address === '*halt*')).toBe(false);
    expect(state.isFinished()).toBe(false);
    expect(result.summary.reason).toBeUndefined();
    expect(result.summary.skipped).toEqual([
      expect.objectContaining({ address: 'a@b.com', reason: 'invoice_unreachable' }),
      expect.objectContaining({ address: 'c@d.com', reason: 'invoice_unreachable' }),
    ]);
  });

  it('treats gifts API network errors as invoice_unreachable', async () => {
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => {
        throw new Error('network down');
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
    expect(state.load()).toEqual([]);
    expect(state.isFinished()).toBe(false);
    expect(result.summary.skipped).toEqual([
      expect.objectContaining({ address: 'a@b.com', reason: 'invoice_unreachable' }),
      expect.objectContaining({ address: 'c@d.com', reason: 'invoice_unreachable' }),
    ]);
  });

  it('treats malformed invoice paymentHash as uncertain halt', async () => {
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () =>
        new Response(
          JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: 'nope', amountMsat: 1_000_000 }),
          { status: 200 },
        ),
      ),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      {
        gifts,
        lndhub,
        state,
        lock: openLock,
        btcUsd: async () => 100_000,
      },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(4);
    expect(state.isFinished()).toBe(true);
    expect(
      state.load().some(
        (row) =>
          (row.address === 'a@b.com' || row.address === '*halt*') && row.status === 'uncertain',
      ),
    ).toBe(true);
    expect(result.summary.uncertain).toEqual([
      expect.objectContaining({ address: 'a@b.com' }),
    ]);
  });

  it('retries invoice_unreachable on a later live run after a partial success', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async (url) => {
        if (url.endsWith('/proof')) {
          return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
        }
        invoices += 1;
        if (invoices === 1) {
          return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
        }
        const amountMsat = invoices === 2 ? 500_000 : 1_000_000;
        return new Response(
          JSON.stringify({
            id: `id${invoices}`,
            pr: 'lnbc1',
            paymentHash: HASH,
            amountMsat,
          }),
          { status: 200 },
        );
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    expect(first.exitCode).toBe(3);
    expect(first.summary.reason).toBeUndefined();
    expect(first.summary.skipped).toEqual([
      expect.objectContaining({ address: 'a@b.com', reason: 'invoice_unreachable' }),
    ]);
    expect(state.load().filter((row) => row.status === 'paid').map((row) => row.address)).toEqual([
      'c@d.com',
    ]);
    expect(state.isFinished()).toBe(false);

    const second = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(second.exitCode).toBe(0);
    expect(state.isFinished()).toBe(true);
    expect(state.load().filter((row) => row.status === 'paid').map((row) => row.address).sort()).toEqual([
      'a@b.com',
      'c@d.com',
    ]);
  });

  it('treats gifts API 401 as failed and continues to the next recipient', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => {
        invoices += 1;
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(4);
    expect(invoices).toBe(2);
    expect(state.isFinished()).toBe(true);
  });

  it('treats dry-run gifts API 401 as failed with exit 4', async () => {
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })),
    );
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: false, day: '2026-08-23' },
      {
        gifts,
        lndhub: new LndhubClient(target),
        state,
        lock: openLock,
        btcUsd: async () => 100_000,
      },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(4);
    expect(result.summary.reason).toBeUndefined();
    expect(state.load().some((row) => row.status === 'uncertain')).toBe(false);
  });

  it('halts on preimage mismatch and does not submit proof', async () => {
    let proofs = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async (url) => {
        if (url.endsWith('/proof')) {
          proofs += 1;
          return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 1_000_000 }),
          { status: 200 },
        );
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: '22'.repeat(32) }), { status: 200 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state: memoryState(), lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(4);
    expect(proofs).toBe(0);
  });

  it('aborts live when the day JSONL is corrupt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts: new GiftsApi('https://api.21.gifts', 'tok'),
      lndhub: new LndhubClient(target),
      state: memoryState('not-json\n'),
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(4);
  });

  it('exits 3 when the live day lock is held', async () => {
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts: new GiftsApi('https://api.21.gifts', 'tok'),
      lndhub: new LndhubClient(target),
      state,
      lock: heldLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
    expect(state.isFinished()).toBe(false);
  });

  it('halts remaining live recipients and persists halt for the UTC day', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async (url) => {
        if (url.endsWith('/proof')) {
          return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
        }
        invoices += 1;
        const bodyAmount = invoices === 1 ? 1_000_000 : 500_000;
        return new Response(
          JSON.stringify({ id: `id${invoices}`, pr: 'lnbc1', paymentHash: HASH, amountMsat: bodyAmount }),
          { status: 200 },
        );
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      throw new Error('pay failed');
    });
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    expect(first.exitCode).toBe(4);
    expect(invoices).toBe(1);
    expect(state.load().some((row) => row.address === '*halt*' && row.status === 'uncertain')).toBe(true);
    expect(state.isFinished()).toBe(true);
    const second = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state,
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(second.exitCode).toBe(4);
    expect(invoices).toBe(1);
  });

  it('halts a later live run when any recipient is already uncertain', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => {
        invoices += 1;
        return new Response(
          JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 500_000 }),
          { status: 200 },
        );
      }),
    );
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const prior = `${JSON.stringify({
      ts: 't',
      address: 'a@b.com',
      invoiceId: 'id0',
      paymentHash: HASH,
      status: 'uncertain',
    })}\n`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state: memoryState(prior),
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(4);
    expect(invoices).toBe(0);
  });

  it('aborts when usd cannot convert to sats', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [{ address: 'a@b.com', amountUsd: 1e-12 }] },
      { live: true, day: '2026-08-23' },
      {
        gifts: new GiftsApi('https://api.21.gifts', 'tok'),
        lndhub: new LndhubClient(target),
        state: memoryState(),
        lock: openLock,
        btcUsd: async () => 100_000,
      },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
  });

  it('treats API 409 as already paid and does not create a second invoice pay', async () => {
    let invoices = 0;
    const gifts = new GiftsApi(
      'https://api.21.gifts',
      'tok',
      giftsFetch(async () => {
        invoices += 1;
        return new Response(JSON.stringify({ error: 'Already paid today' }), { status: 409 });
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const state = memoryState();
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      {
        gifts,
        lndhub: new LndhubClient(target, async (url) => {
          if (String(url).endsWith('/auth')) {
            return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
          }
          return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
        }),
        state,
        lock: openLock,
        btcUsd: async () => 100_000,
      },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(invoices).toBe(1);
    expect(state.load().some((row) => row.status === 'paid' && row.invoiceId === 'already-paid')).toBe(true);
    expect(state.isFinished()).toBe(true);
  });

  it('aborts when Coinbase spot is unreadable', async () => {
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts: new GiftsApi('https://api.21.gifts', 'tok'),
      lndhub: new LndhubClient(target),
      state,
      lock: openLock,
      btcUsd: async () => null,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
    expect(state.isFinished()).toBe(false);
  });
});
