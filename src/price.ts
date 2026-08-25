const COINBASE_SPOT = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';

/**
 * Coinbase BTC-USD spot price.
 *
 * @param fetchImpl - Injected fetch (tests).
 * @returns USD per BTC, or `null` when the response is unusable.
 */
export async function fetchBtcUsdSpot(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const response = await fetchImpl(COINBASE_SPOT);
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
