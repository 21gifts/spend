import type { Recipient } from './config';
import type { DashboardData } from './dashboard';
import { lightningQrPayload } from './dashboard';
import { displayLightningAddress, renderDocument, slot } from './html-shell';
import { bitcoinQrSvg } from './qr';

const TITLE = '21.gifts spend';

const NULL_DASHBOARD: DashboardData = {
  sats: null,
  usd: null,
  lightningAddress: null,
};

const PENCIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

const TRASH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

/**
 * Optional panel below the Spend block on the combined page.
 *
 * - `login` — password form when the editor is configured but there is no session
 * - `editor` — payment comment + daily and moderator rosters when the session is valid
 */
export type SpendPanel =
  | { kind: 'login'; error?: string }
  | {
      kind: 'editor';
      recipients: Recipient[];
      moderators: Recipient[];
      comment: string;
      paymentsEnabled: boolean;
      moderatorPaymentsEnabled: boolean;
      error?: string;
    };

function formatSats(sats: number | null): string {
  return sats === null ? 'unavailable' : `${sats} sats`;
}

function formatUsd(usd: number | null): string {
  return usd === null ? 'unavailable' : `${usd.toFixed(2)} USD`;
}

function formatUsdTotal(sum: number): string {
  const rounded = Math.round(sum * 100) / 100;
  return String(rounded);
}

/**
 * One roster row. `actionPrefix` is `/recipients` or `/moderators`.
 *
 * @param row - Address and USD amount.
 * @param actionPrefix - POST path prefix for update/delete.
 * @returns List-item HTML.
 */
function renderRow(row: Recipient, actionPrefix: '/recipients' | '/moderators'): string {
  const full = slot(row.address);
  const display = slot(displayLightningAddress(row.address));
  const usd = slot(String(row.amountUsd));
  const named = actionPrefix === '/moderators' ? `moderator ${full}` : full;
  return `<li class="row">
              <span class="addr" title="${full}">${display}</span>
              <form class="inline" method="post" action="${actionPrefix}/update">
                <input type="hidden" name="address" value="${full}">
                <input name="amountUsd" type="text" inputmode="decimal" value="${usd}" aria-label="USD amount for ${named}">
                <button class="icon" type="submit" aria-label="Update ${named}" title="Update">${PENCIL_SVG}</button>
              </form>
              <form class="inline" method="post" action="${actionPrefix}/delete">
                <input type="hidden" name="address" value="${full}">
                <button class="icon danger" type="submit" aria-label="Delete ${named}" title="Delete">${TRASH_SVG}</button>
              </form>
            </li>`;
}

function renderTotalRow(recipients: Recipient[]): string {
  const sum = recipients.reduce((acc, r) => acc + r.amountUsd, 0);
  const usd = slot(formatUsdTotal(sum));
  return `<li class="row total">
              <span class="addr">Total</span>
              <span class="inline">
                <span class="usd-total">${usd}</span>
                <span class="icon-spacer" aria-hidden="true"></span>
              </span>
              <span class="inline">
                <span class="icon-spacer" aria-hidden="true"></span>
              </span>
            </li>`;
}

/**
 * Roster card: rows plus Total, or a muted empty message.
 *
 * @param rows - List to render.
 * @param actionPrefix - POST path prefix for row forms.
 * @param emptyMessage - Shown when `rows` is empty.
 * @returns Card HTML.
 */
function renderRosterCard(
  rows: Recipient[],
  actionPrefix: '/recipients' | '/moderators',
  emptyMessage: string,
): string {
  if (rows.length === 0) {
    return `<div class="card"><p class="muted">${emptyMessage}</p></div>`;
  }
  return `<div class="card">
          <ul class="roster">
            ${rows.map((row) => renderRow(row, actionPrefix)).join('\n            ')}
            ${renderTotalRow(rows)}
          </ul>
        </div>`;
}

/**
 * Add-row form posting to `/recipients/add` or `/moderators/add`.
 *
 * @param action - Form action path.
 * @returns Form HTML.
 */
function renderAddForm(action: '/recipients/add' | '/moderators/add'): string {
  return `<form class="card add-grid" method="post" action="${action}">
    <label class="field grow">
      <span>Address</span>
      <input name="address" type="text" autocomplete="off">
    </label>
    <label class="field usd">
      <span>USD</span>
      <input name="amountUsd" type="text" inputmode="decimal">
    </label>
    <button class="primary" type="submit">Add</button>
  </form>`;
}

/**
 * On/Off switch posting `enabled=on` or `enabled=off`.
 *
 * @param action - Form action path.
 * @param ariaLabel - Accessible name for the form.
 * @param enabled - Persisted flag; the matching button is primary and pressed.
 * @returns Form HTML.
 */
function renderPaymentsSwitch(
  action: '/recipients/payments' | '/moderators/payments',
  ariaLabel: 'Daily payments' | 'Moderator payments',
  enabled: boolean,
): string {
  const onClass = enabled ? 'primary' : 'ghost';
  const offClass = enabled ? 'ghost' : 'primary';
  const onPressed = enabled ? 'true' : 'false';
  const offPressed = enabled ? 'false' : 'true';
  return `<form class="card payments-switch" method="post" action="${action}" aria-label="${ariaLabel}">
  <span class="switch-label">Payments</span>
  <button type="submit" name="enabled" value="on" class="${onClass}" aria-pressed="${onPressed}">On</button>
  <button type="submit" name="enabled" value="off" class="${offClass}" aria-pressed="${offPressed}">Off</button>
</form>`;
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
 * Payment comment + daily roster + moderator roster + add forms (below Spend).
 *
 * @param recipients - Current daily recipient list
 * @param comment - File-level LUD-12 payment comment
 * @param moderators - Current moderator stipend list
 * @param paymentsEnabled - Daily-payments switch
 * @param moderatorPaymentsEnabled - Moderator-payments switch
 * @param error - Optional error shown above the payment comment heading
 * @returns Inner HTML fragment
 */
function renderEditorPanel(
  recipients: Recipient[],
  comment: string,
  moderators: Recipient[],
  paymentsEnabled: boolean,
  moderatorPaymentsEnabled: boolean,
  error?: string,
): string {
  const errorHtml =
    error === undefined ? '' : `<p class="error">${slot(error)}</p>`;
  return `${errorHtml}
  <h2>Payment comment</h2>
  <form class="card comment-form" method="post" action="/recipients/comment">
    <label class="field grow">
      <span>Comment</span>
      <textarea name="comment" rows="3" aria-label="Payment comment">${slot(comment)}</textarea>
    </label>
    <button class="primary" type="submit">Save</button>
  </form>
  <h2>Recipients</h2>
  ${renderPaymentsSwitch('/recipients/payments', 'Daily payments', paymentsEnabled)}
  ${renderRosterCard(recipients, '/recipients', 'No recipients')}
  <h2>Add recipient</h2>
  ${renderAddForm('/recipients/add')}
  <h2>Moderators</h2>
  ${renderPaymentsSwitch('/moderators/payments', 'Moderator payments', moderatorPaymentsEnabled)}
  ${renderRosterCard(moderators, '/moderators', 'No moderators')}
  <h2>Add moderator</h2>
  ${renderAddForm('/moderators/add')}`;
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
  ${renderEditorPanel(panel.recipients, panel.comment, panel.moderators, panel.paymentsEnabled, panel.moderatorPaymentsEnabled, panel.error)}
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
 * Recipients wrapper around the combined renderer (null dashboard + editor panel).
 *
 * @param opts.recipients - Current daily recipient list
 * @param opts.moderators - Current moderator stipend list
 * @param opts.comment - File-level LUD-12 payment comment
 * @param opts.paymentsEnabled - Daily-payments switch
 * @param opts.moderatorPaymentsEnabled - Moderator-payments switch
 * @param opts.error - Optional error message shown above the payment comment heading
 * @returns Complete HTML document.
 */
export function renderRecipientsHtml(opts: {
  recipients: Recipient[];
  moderators: Recipient[];
  comment: string;
  paymentsEnabled: boolean;
  moderatorPaymentsEnabled: boolean;
  error?: string;
}): string {
  return renderDashboardHtml(
    NULL_DASHBOARD,
    opts.error === undefined
      ? {
          kind: 'editor',
          recipients: opts.recipients,
          moderators: opts.moderators,
          comment: opts.comment,
          paymentsEnabled: opts.paymentsEnabled,
          moderatorPaymentsEnabled: opts.moderatorPaymentsEnabled,
        }
      : {
          kind: 'editor',
          recipients: opts.recipients,
          moderators: opts.moderators,
          comment: opts.comment,
          paymentsEnabled: opts.paymentsEnabled,
          moderatorPaymentsEnabled: opts.moderatorPaymentsEnabled,
          error: opts.error,
        },
  );
}
