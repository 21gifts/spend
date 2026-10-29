import type { DashboardData } from './dashboard';
import { lightningQrPayload } from './dashboard';
import { renderDocument, slot } from './html-shell';
import { bitcoinQrSvg } from './qr';

const TITLE = '21.gifts spend';

/** Daily payment text on 21.gifts. The spend page does not edit it. */
const DAILY_TEXT_HREF = 'https://21.gifts/grants/payments/comment';

/** Daily payment amounts on 21.gifts. The spend page does not edit them. */
const DAILY_AMOUNTS_HREF = 'https://21.gifts/grants/payments/amounts';

/** Moderator payments on 21.gifts. The spend page does not edit them. */
const MODERATOR_PAYMENTS_HREF = 'https://21.gifts/grants/payments/moderators';

const NULL_DASHBOARD: DashboardData = {
  sats: null,
  usd: null,
  lightningAddress: null,
};

/**
 * Optional panel below the Spend block on the combined page.
 *
 * - `login` — password form when the editor is configured but there is no session
 * - `editor` — links to the 21.gifts payment pages when the session is valid
 */
export type SpendPanel =
  | { kind: 'login'; error?: string }
  | { kind: 'editor'; error?: string };

function formatSats(sats: number | null): string {
  return sats === null ? 'unavailable' : `${sats} sats`;
}

function formatUsd(usd: number | null): string {
  return usd === null ? 'unavailable' : `${usd.toFixed(2)} USD`;
}

/**
 * Login form panel (below the Spend block).
 *
 * @param error - Optional error shown above the form
 * @returns Inner HTML fragment
 */
function renderLoginPanel(error?: string): string {
  const errorHtml =
    error === undefined ? '' : `<p class="error">${slot(error)}</p>`;
  return `<h2>Log in</h2>
  ${errorHtml}
  <form class="card login-form" method="post" action="/">
    <label class="field grow">
      <span>Password</span>
      <input name="password" type="password" autocomplete="current-password">
    </label>
    <button class="primary" type="submit">Log in</button>
  </form>`;
}

/**
 * Links to the three 21.gifts pages that edit daily and moderator payments.
 *
 * @returns Heading and three buttons. No roster and no comment field.
 */
function renderDailyLinks(): string {
  return `<h2>Daily payments</h2>
  <div class="card daily-links">
    <a class="primary" href="${DAILY_TEXT_HREF}">Daily payment text</a>
    <a class="primary" href="${DAILY_AMOUNTS_HREF}">Daily payment amounts</a>
    <a class="primary" href="${MODERATOR_PAYMENTS_HREF}">Moderator payments</a>
  </div>`;
}

/**
 * Optional error plus links to the 21.gifts payment pages (below Spend).
 *
 * @param error - Optional error shown above the payment links
 * @returns Inner HTML fragment
 */
function renderEditorPanel(error?: string): string {
  const errorHtml =
    error === undefined ? '' : `<p class="error">${slot(error)}</p>`;
  return `${errorHtml}
  ${renderDailyLinks()}`;
}

function renderSpendFields(data: DashboardData): string {
  const addressHtml =
    data.lightningAddress === null ? 'unavailable' : slot(data.lightningAddress);
  const qr =
    data.lightningAddress === null
      ? ''
      : `<div class="qr">${bitcoinQrSvg(lightningQrPayload(data.lightningAddress))}</div>`;
  return `<p class="kicker">Balance</p>
  <p class="balance-sats">${slot(formatSats(data.sats))}</p>
  <p class="balance-usd">${slot(formatUsd(data.usd))}</p>
  <p class="kicker">Lightning address</p>
  <p class="addr">${addressHtml}</p>
  ${qr}`;
}

function renderBody(data: DashboardData, panel?: SpendPanel, unconfigured?: boolean): string {
  const spendFields = renderSpendFields(data);
  if (panel?.kind === 'editor') {
    return `<div class="wrap">
  <div class="topbar">
    <div>
      <p class="brand">21.gifts</p>
      <h1>Spend</h1>
    </div>
    <form method="post" action="/logout"><button class="ghost" type="submit">Log out</button></form>
  </div>
  ${spendFields}
  ${renderEditorPanel(panel.error)}
</div>`;
  }
  if (panel?.kind === 'login') {
    return `<div class="wrap">
  <p class="brand">21.gifts</p>
  <h1>Spend</h1>
  ${spendFields}
  ${renderLoginPanel(panel.error)}
</div>`;
  }
  if (unconfigured) {
    return `<div class="wrap">
  <p class="brand">21.gifts</p>
  <h1>Spend</h1>
  ${spendFields}
  <p class="muted">Recipient editor is not configured</p>
</div>`;
  }
  return `<div class="wrap">
  <p class="brand">21.gifts</p>
  <h1>Spend</h1>
  ${spendFields}
</div>`;
}

/**
 * Server-rendered dashboard: balance and Lightning Address + QR, with an optional panel.
 * Dashboard-only when `panel` is omitted (no Log in, no `/login` string).
 *
 * @param data - Current values.
 * @param panel - Optional login or editor panel.
 * @returns HTML document.
 */
export function renderDashboardHtml(data: DashboardData, panel?: SpendPanel): string {
  return renderDocument({ title: TITLE, body: renderBody(data, panel) });
}

/**
 * Spend block plus muted “Recipient editor is not configured” (HTTP 503).
 *
 * @param data - Dashboard values (often loaded; nulls show as unavailable).
 * @returns HTML document.
 */
export function renderUnconfiguredHtml(data: DashboardData): string {
  return renderDocument({ title: TITLE, body: renderBody(data, undefined, true) });
}

/**
 * Login wrapper around the combined renderer (null dashboard).
 * When `disabled`, Spend block + muted unconfigured notice (no password input).
 *
 * @param opts.error - Optional error message shown above the form
 * @param opts.disabled - When true, show the unconfigured notice instead of the form
 * @returns Complete HTML document.
 */
export function renderLoginHtml(opts: { error?: string; disabled?: boolean } = {}): string {
  if (opts.disabled) {
    return renderUnconfiguredHtml(NULL_DASHBOARD);
  }
  return renderDashboardHtml(
    NULL_DASHBOARD,
    opts.error === undefined ? { kind: 'login' } : { kind: 'login', error: opts.error },
  );
}

/**
 * Logged-in dashboard. Daily and moderator fields are not rendered.
 * Three buttons link to the 21.gifts pages that edit them.
 *
 * @param opts.error - Optional error message shown above the payment links
 * @returns Complete HTML document.
 */
export function renderRecipientsHtml(opts: { error?: string } = {}): string {
  return renderDashboardHtml(
    NULL_DASHBOARD,
    opts.error === undefined ? { kind: 'editor' } : { kind: 'editor', error: opts.error },
  );
}
