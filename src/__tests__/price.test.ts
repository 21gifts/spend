import { describe, it, expect } from 'vitest';
import { fetchBtcUsdSpot } from '../price';

describe('fetchBtcUsdSpot', () => {
  it('parses Coinbase data.amount', async () => {
    const n = await fetchBtcUsdSpot(async () =>
      new Response(JSON.stringify({ data: { amount: '100000.50' } }), { status: 200 }),
    );
    expect(n).toBe(100000.5);
  });

  it('returns null on a bad payload', async () => {
    const n = await fetchBtcUsdSpot(async () => new Response('{}', { status: 200 }));
    expect(n).toBeNull();
  });

  it('returns null on a non-OK HTTP status', async () => {
    const n = await fetchBtcUsdSpot(async () => new Response('{}', { status: 502 }));
    expect(n).toBeNull();
  });
});
