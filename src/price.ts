/** Default Coinbase BTC-USD spot endpoint. */
export const DEFAULT_BTC_USD_SPOT_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';

/**
 * Spot URL: `BTC_USD_SPOT_URL` when set, otherwise Coinbase.
 *
 * @param env - Process env (tests inject).
 * @returns Absolute URL.
 */
export function btcUsdSpotUrl(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const raw = env['BTC_USD_SPOT_URL']?.trim();
  return raw !== undefined && raw !== '' ? raw : DEFAULT_BTC_USD_SPOT_URL;
}

/**
 * Convert a USD gift to whole sats at a BTC-USD spot price.
 *
 * @param usd - Gift amount in USD.
 * @param btcUsd - USD per BTC.
 * @returns Whole satoshis, or `null` when the inputs are unusable.
 */
export function usdToSats(usd: number, btcUsd: number): number | null {
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(btcUsd) || btcUsd <= 0) {
    return null;
  }
  const sats = Math.round((usd / btcUsd) * 1e8);
  if (!Number.isInteger(sats) || sats < 1) {
    return null;
  }
  return sats;
}

/**
 * Coinbase BTC-USD spot price.
 *
 * @param fetchImpl - Injected fetch (tests).
 * @param url - Spot endpoint; default {@link btcUsdSpotUrl}.
 * @returns USD per BTC, or `null` when the response is unusable.
 */
export async function fetchBtcUsdSpot(
  fetchImpl: typeof fetch = fetch,
  url: string = btcUsdSpotUrl(),
): Promise<number | null> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return null;
    }
    const json: unknown = await response.json();
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      return null;
    }
    const data = (json as Record<string, unknown>)['data'];
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }
    const amount = (data as Record<string, unknown>)['amount'];
    const n = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      return null;
    }
    return n;
  } catch {
    return null;
  }
}
