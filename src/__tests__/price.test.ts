import { describe, it, expect } from 'vitest';
import { DEFAULT_BTC_USD_SPOT_URL, btcUsdSpotUrl, fetchBtcUsdSpot, usdToSats } from '../price';

describe('btcUsdSpotUrl', () => {
  it('defaults to Coinbase and honours BTC_USD_SPOT_URL', () => {
    expect(btcUsdSpotUrl({})).toBe(DEFAULT_BTC_USD_SPOT_URL);
    expect(btcUsdSpotUrl({ BTC_USD_SPOT_URL: '' })).toBe(DEFAULT_BTC_USD_SPOT_URL);
    expect(btcUsdSpotUrl({ BTC_USD_SPOT_URL: ' http://127.0.0.1:3998/v2/prices/BTC-USD/spot ' })).toBe(
      'http://127.0.0.1:3998/v2/prices/BTC-USD/spot',
    );
  });
});

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

describe('usdToSats', () => {
  it('converts USD at the given spot', () => {
    expect(usdToSats(1, 100_000)).toBe(1000);
    expect(usdToSats(2.5, 78094.995)).toBe(3201);
  });

  it('returns null for unusable inputs', () => {
    expect(usdToSats(0, 100_000)).toBeNull();
    expect(usdToSats(1, 0)).toBeNull();
    expect(usdToSats(1, NaN)).toBeNull();
  });
});
