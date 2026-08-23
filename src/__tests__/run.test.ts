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
    { address: 'a@b.com', amountSats: 1000 },
    { address: 'c@d.com', amountSats: 500 },
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

describe('runDay', () => {
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
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
    expect(paid).toBe(0);
  });

  it('live pays then submits the preimage', async () => {
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runDay(
      { ...config, recipients: [config.recipients[0]!] },
      { live: true, day: '2026-08-23' },
      { gifts, lndhub, state: memoryState() },
    );
    warn.mockRestore();
    expect(result.exitCode).toBe(0);
  });

  it('skips addresses already paid and aborts on low balance', async () => {
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
    });
    warn.mockRestore();
    expect(result.exitCode).toBe(3);
  });
});
