/** Values shown on GET `/`. */
export interface DashboardData {
  sats: number | null;
  usd: number | null;
  lightningAddress: string | null;
}

/**
 * QR payload wallets scan for a Lightning Address (LUD-16).
 *
 * @param address - Lightning Address `user@domain`.
 * @returns `lightning:` URI.
 */
export function lightningQrPayload(address: string): string {
  return `lightning:${address}`;
}

/**
 * Load balance. Lightning Address comes from config, not LNDHub on-chain.
 *
 * @param deps - LNDHub + spot + Lightning Address.
 * @returns Dashboard fields; nulls mean unavailable.
 */
export async function loadDashboard(deps: {
  lndhub: {
    auth(): Promise<string>;
    balance(token: string): Promise<number | null>;
  };
  btcUsd: () => Promise<number | null>;
  lightningAddress: string | null;
}): Promise<DashboardData> {
  let sats: number | null = null;
  let token: string | null = null;
  try {
    token = await deps.lndhub.auth();
  } catch {
    token = null;
  }
  if (token !== null) {
    try {
      sats = await deps.lndhub.balance(token);
    } catch {
      sats = null;
    }
  }
  let usd: number | null = null;
  if (sats !== null) {
    const spot = await deps.btcUsd();
    if (spot !== null) {
      usd = (sats / 1e8) * spot;
    }
  }
  return { sats, usd, lightningAddress: deps.lightningAddress };
}
