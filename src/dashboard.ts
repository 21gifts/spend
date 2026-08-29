import { bitcoinQrSvg } from './qr';
import { renderDocument, slot } from './html-shell';

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

function formatSats(sats: number | null): string {
  return sats === null ? 'unavailable' : `${sats} sats`;
}

function formatUsd(usd: number | null): string {
  return usd === null ? 'unavailable' : `${usd.toFixed(2)} USD`;
}

/**
 * Server-rendered dashboard: balance and Lightning Address + QR.
 *
 * @param data - Current values.
 * @returns HTML document.
 */
export function renderDashboardHtml(data: DashboardData): string {
  const addressHtml =
    data.lightningAddress === null ? 'unavailable' : slot(data.lightningAddress);
  const qr =
    data.lightningAddress === null
      ? ''
      : `<div class="qr">${bitcoinQrSvg(lightningQrPayload(data.lightningAddress))}</div>`;
  const body = `<div class="wrap">
  <p class="brand">21.gifts</p>
  <h1>Spend</h1>
  <p class="kicker">Balance</p>
  <p class="balance-sats">${slot(formatSats(data.sats))}</p>
  <p class="balance-usd">${slot(formatUsd(data.usd))}</p>
  <p class="kicker">Lightning address</p>
  <p class="addr">${addressHtml}</p>
  ${qr}
</div>`;
  return renderDocument({ title: '21.gifts spend', body });
}
