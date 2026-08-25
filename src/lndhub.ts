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
  /** Memoized deposit address; `undefined` until the first lookup. */
  private depositCache: string | null | undefined = undefined;

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
   * On-chain deposit address for topping up this LNDHub account.
   *
   * Looks up `/getbtc` first. `POST /newbtc` runs at most once per process
   * so a public dashboard refresh cannot mint unbounded addresses.
   *
   * @param token - Access token from {@link auth}.
   * @returns First existing address, a newly created one, or `null`.
   */
  async getDepositAddress(token: string): Promise<string | null> {
    if (this.depositCache !== undefined) {
      return this.depositCache;
    }
    const existing = firstAddress(await this.requestArray('GET', '/getbtc', token));
    if (existing !== null) {
      this.depositCache = existing;
      return existing;
    }
    const created = await this.request('POST', '/newbtc', {}, token);
    this.depositCache = usableAddress(created['address']);
    return this.depositCache;
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
   * lightning.space `/payinvoice` often returns a 64-zero `payment_preimage`
   * on success. The real preimage is on `/gettxs` for the same `payment_hash`.
   *
   * @param token - Access token.
   * @param invoice - BOLT11 `pr`.
   * @returns Preimage hex when present.
   */
  async payInvoice(token: string, invoice: string): Promise<{ preimage: string | null }> {
    const json = await this.request('POST', '/payinvoice', { invoice }, token);
    const fromPay = usablePreimage(json['payment_preimage'] ?? json['preimage']);
    if (fromPay !== null) {
      return { preimage: fromPay };
    }
    const hash = typeof json['payment_hash'] === 'string' ? json['payment_hash'] : '';
    const fromTxs = await this.preimageFromTxs(token, hash);
    return { preimage: fromTxs };
  }

  /**
   * Look up a non-zero preimage on LNDHub `/gettxs`.
   *
   * @param token - Access token.
   * @param paymentHash - Hex payment hash from `/payinvoice`.
   * @returns Preimage hex, or `null`.
   */
  private async preimageFromTxs(token: string, paymentHash: string): Promise<string | null> {
    const want = paymentHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) {
      return null;
    }
    const txs = await this.requestArray('GET', '/gettxs', token);
    for (const tx of txs) {
      if (tx === null || typeof tx !== 'object') {
        continue;
      }
      const rec = tx as Record<string, unknown>;
      const hash = typeof rec['payment_hash'] === 'string' ? rec['payment_hash'].trim().toLowerCase() : '';
      if (hash !== want) {
        continue;
      }
      return usablePreimage(rec['payment_preimage'] ?? rec['preimage']);
    }
    return null;
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
    const json = await this.fetchJson(method, path, init);
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      return json as Record<string, unknown>;
    }
    return {};
  }

  private async requestArray(method: string, path: string, token: string): Promise<unknown[]> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const json = await this.fetchJson(method, path, { method, headers });
    return Array.isArray(json) ? json : [];
  }

  private async fetchJson(method: string, path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.target.baseUrl}${path}`, init);
    let json: unknown = {};
    try {
      json = await response.json();
    } catch {
      json = {};
    }
    if (!response.ok) {
      const record = json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
      const error = typeof record['error'] === 'string' ? record['error'] : `HTTP ${response.status}`;
      throw new Error(error);
    }
    return json;
  }
}

function firstAddress(rows: unknown[]): string | null {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      continue;
    }
    const address = usableAddress((row as Record<string, unknown>)['address']);
    if (address !== null) {
      return address;
    }
  }
  return null;
}

function usableAddress(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const address = value.trim();
  return address === '' ? null : address;
}

/** 32-byte hex preimage that is not the LNDHub all-zero placeholder. */
function usablePreimage(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex) || /^0+$/.test(hex)) {
    return null;
  }
  return hex;
}
