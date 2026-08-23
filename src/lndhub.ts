/** Parsed `lndhub://login:password@https://host/path`. */
export interface LndhubTarget {
  login: string;
  password: string;
  baseUrl: string;
}

/**
 * Parse an LNDHub export URI.
 *
 * @param uri - `lndhub://…` string.
 * @returns Login, password, and API base, or `null`.
 */
export function parseLndhubUri(uri: string): LndhubTarget | null {
  const match = /^lndhub:\/\/([^:]+):([^@]+)@(https?:\/\/.+)$/.exec(uri.trim());
  if (match === null) {
    return null;
  }
  const login = match[1];
  const password = match[2];
  const base = match[3];
  if (login === undefined || password === undefined || base === undefined) {
    return null;
  }
  return { login, password, baseUrl: base.replace(/\/+$/, '') };
}

/**
 * LNDHub client (lightning.space / LNbits).
 */
export class LndhubClient {
  constructor(
    private readonly target: LndhubTarget,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Authenticate and return the access token.
   *
   * @returns Bearer token.
   */
  async auth(): Promise<string> {
    const json = await this.request('POST', '/auth', {
      login: this.target.login,
      password: this.target.password,
    });
    const token = json['access_token'] ?? json['accessToken'];
    if (typeof token !== 'string' || token === '') {
      throw new Error('LNDHub auth did not return access_token');
    }
    return token;
  }

  /**
   * Available balance in sats.
   *
   * @param token - Access token from {@link auth}.
   * @returns Integer sats, or `null` when the shape is unknown.
   */
  async balance(token: string): Promise<number | null> {
    const json = await this.request('GET', '/balance', undefined, token);
    const btc = json['BTC'];
    if (btc !== null && typeof btc === 'object') {
      const available = (btc as Record<string, unknown>)['AvailableBalance'];
      if (typeof available === 'number') {
        return available;
      }
    }
    const balance = json['balance'];
    if (typeof balance === 'number') {
      return Math.trunc(balance);
    }
    return null;
  }

  /**
   * Pay a BOLT11 invoice.
   *
   * @param token - Access token.
   * @param invoice - BOLT11 `pr`.
   * @returns Preimage hex when present.
   */
  async payInvoice(token: string, invoice: string): Promise<{ preimage: string | null }> {
    const json = await this.request('POST', '/payinvoice', { invoice }, token);
    const preimage = json['payment_preimage'] ?? json['preimage'];
    if (typeof preimage === 'string' && preimage !== '') {
      return { preimage };
    }
    return { preimage: null };
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    token?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) {
      headers['authorization'] = `Bearer ${token}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(`${this.target.baseUrl}${path}`, init);
    let json: unknown = {};
    try {
      json = await response.json();
    } catch {
      json = {};
    }
    const record = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = typeof record['error'] === 'string' ? record['error'] : `HTTP ${response.status}`;
      throw new Error(error);
    }
    return record;
  }
}
