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
  recipients: [
    { address: 'a@b.com', amountUsd: 1 },
    { address: 'c@d.com', amountUsd: 0.5 },
  ],
};

const target = parseLndhubUri(config.lndhubUri);
if (target === null) {
  throw new Error('fixture');
}

function memoryState(existing = ''): DayState {
  let file = existing;
  return new DayState('/tmp', '2026-08-23', {
    exists: () => file !== '',
    read: () => file,
    append: (_p, data) => {
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
    const failing = new GiftsApi('https://api.21.gifts', 'tok', async () =>
      new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
    );
    const state = memoryState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dry = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: false, day: '2026-08-23' },
      { gifts: failing, lndhub: new LndhubClient(target), state, lock: openLock, btcUsd: async () => 100_000 },
    );
    expect(dry.exitCode).toBe(4);
    expect(state.load().some((row) => row.status === 'uncertain')).toBe(false);
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async (url) => {
      if (String(url).endsWith('/proof')) {
        return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 1_000_000 }),
        { status: 200 },
      );
    });
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
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async (_url, init) => {
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
    });
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
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async (url, init) => {
      if (String(url).endsWith('/proof')) {
        proofBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 1_000_000 }),
        { status: 200 },
      );
    });
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (String(url).endsWith('/balance')) {
        return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ payment_preimage: PREIMAGE }), { status: 200 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state: memoryState(), lock: openLock, btcUsd: async () => 100_000 },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(proofBody).toEqual({ id: 'id1', preimage: PREIMAGE });
  });

  it('skips addresses already paid', async () => {
    let invoices = 0;
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      invoices += 1;
      return new Response('{}', { status: 500 });
    });
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

  it('aborts on low balance', async () => {
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 10 } }), { status: 200 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts: new GiftsApi('https://api.21.gifts', 'tok'),
      lndhub,
      state: memoryState(),
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
  });

  it('treats gifts API 503 as uncertain halt and does not retry the rest', async () => {
    let invoices = 0;
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      invoices += 1;
      return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
    });
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state: memoryState(),
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(4);
    expect(invoices).toBe(1);
  });

  it('treats gifts API 401 as failed and continues to the next recipient', async () => {
    let invoices = 0;
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      invoices += 1;
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    });
    const lndhub = new LndhubClient(target, async (url) => {
      if (String(url).endsWith('/auth')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ BTC: { AvailableBalance: 1_000_000 } }), { status: 200 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts,
      lndhub,
      state: memoryState(),
      lock: openLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(4);
    expect(invoices).toBe(2);
  });

  it('halts on preimage mismatch and does not submit proof', async () => {
    let proofs = 0;
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async (url) => {
      if (String(url).endsWith('/proof')) {
        proofs += 1;
        return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 1_000_000 }),
        { status: 200 },
      );
    });
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts: new GiftsApi('https://api.21.gifts', 'tok'),
      lndhub: new LndhubClient(target),
      state: memoryState(),
      lock: heldLock,
      btcUsd: async () => 100_000,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
  });

  it('halts remaining live recipients and persists halt for the UTC day', async () => {
    let invoices = 0;
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async (url) => {
      if (String(url).endsWith('/proof')) {
        return new Response(JSON.stringify({ status: 'paid' }), { status: 200 });
      }
      invoices += 1;
      const bodyAmount = invoices === 1 ? 1_000_000 : 500_000;
      return new Response(
        JSON.stringify({ id: `id${invoices}`, pr: 'lnbc1', paymentHash: HASH, amountMsat: bodyAmount }),
        { status: 200 },
      );
    });
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
    const gifts = new GiftsApi('https://api.21.gifts', 'tok', async () => {
      invoices += 1;
      return new Response(
        JSON.stringify({ id: 'id1', pr: 'lnbc1', paymentHash: HASH, amountMsat: 500_000 }),
        { status: 200 },
      );
    });
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

  it('aborts when Coinbase spot is unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(config, { live: true, day: '2026-08-23' }, {
      gifts: new GiftsApi('https://api.21.gifts', 'tok'),
      lndhub: new LndhubClient(target),
      state: memoryState(),
      lock: openLock,
      btcUsd: async () => null,
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
  });
});
