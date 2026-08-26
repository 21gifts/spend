import { bitcoinQrSvg } from './qr';

/** Values shown on GET `/`. */
export interface DashboardData {
  sats: number | null;
  usd: number | null;
  address: string | null;
}

/**
 * Load balance and deposit address.
 *
 * @param deps - LNDHub + spot price.
 * @returns Dashboard fields; nulls mean unavailable.
 */
export async function loadDashboard(deps: {
  lndhub: {
    auth(): Promise<string>;
    balance(token: string): Promise<number | null>;
    getDepositAddress(token: string): Promise<string | null>;
  };
  btcUsd: () => Promise<number | null>;
}): Promise<DashboardData> {
  let sats: number | null = null;
  let address: string | null = null;
  let token: string | null = null;
  try {
    token = await deps.lndhub.auth();
    sats = await deps.lndhub.balance(token);
  } catch {
    token = null;
    sats = null;
  }
  if (token !== null) {
    try {
      address = await deps.lndhub.getDepositAddress(token);
    } catch {
      address = null;
    }
  }
  let usd: number | null = null;
  if (sats !== null) {
    const spot = await deps.btcUsd();
    if (spot !== null) {
      usd = (sats / 1e8) * spot;
    }
  }
  return { sats, usd, address };
}

function slot(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatSats(sats: number | null): string {
  return sats === null ? 'unavailable' : `${sats} sats`;
}

function formatUsd(usd: number | null): string {
  return usd === null ? 'unavailable' : `${usd.toFixed(2)} USD`;
}

/**
 * Server-rendered dashboard HTML. Only balance (sats + USD) and deposit address + QR.
 *
 * @param data - Current values.
 * @returns HTML document.
 */
export function renderDashboardHtml(data: DashboardData): string {
  const addressText = data.address === null ? 'unavailable' : data.address;
  const qr =
    data.address === null
      ? ''
      : `<div class="qr">${bitcoinQrSvg(data.address)}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>21.gifts spend</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
dt{font-weight:600;margin-top:1.25rem}
dd{margin:0.35rem 0 0}
.addr{word-break:break-all;font-family:ui-monospace,monospace}
.qr svg{width:12rem;height:12rem;margin-top:0.75rem}
</style>
</head>
<body>
<dl>
<dt>Balance</dt>
<dd>${slot(formatSats(data.sats))}</dd>
<dd>${slot(formatUsd(data.usd))}</dd>
<dt>Deposit address</dt>
<dd class="addr">${slot(addressText)}</dd>
${qr}
</dl>
</body>
</html>
`;
}
