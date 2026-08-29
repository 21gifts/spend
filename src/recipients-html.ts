import type { Recipient } from './config';
import { displayLightningAddress, renderDocument, slot } from './html-shell';

const PENCIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

const TRASH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

/**
 * Login page for the recipient editor.
 *
 * @param opts.error - Optional error message shown above the form
 * @param opts.disabled - When true, show the unconfigured notice instead of the form
 */
export function renderLoginHtml(opts: { error?: string; disabled?: boolean } = {}): string {
  const error =
    opts.error === undefined ? '' : `<p class="error">${slot(opts.error)}</p>`;
  const body = opts.disabled
    ? `<div class="wrap">
  <p class="brand">21.gifts</p>
  <h1>Spend login</h1>
  <p class="muted">Recipient editor is not configured</p>
</div>`
    : `<div class="wrap">
  <p class="brand">21.gifts</p>
  <h1>Spend login</h1>
  ${error}
  <form class="card" method="post" action="/login">
    <p><label>Password<br><input name="password" type="password" autocomplete="current-password"></label></p>
    <p><button class="primary" type="submit">Log in</button></p>
  </form>
</div>`;
  return renderDocument({ title: '21.gifts spend login', body });
}

function renderRow(row: Recipient): string {
  const full = slot(row.address);
  const display = slot(displayLightningAddress(row.address));
  const usd = slot(String(row.amountUsd));
  return `<li class="row">
              <span class="addr" title="${full}">${display}</span>
              <form class="inline" method="post" action="/recipients/update">
                <input type="hidden" name="address" value="${full}">
                <input name="amountUsd" type="text" inputmode="decimal" value="${usd}" aria-label="USD">
                <button class="icon" type="submit" aria-label="Update" title="Update">${PENCIL_SVG}</button>
              </form>
              <form class="inline" method="post" action="/recipients/delete">
                <input type="hidden" name="address" value="${full}">
                <button class="icon danger" type="submit" aria-label="Delete" title="Delete">${TRASH_SVG}</button>
              </form>
            </li>`;
}

/**
 * Authenticated recipient editor page.
 *
 * @param opts.recipients - Current recipient list
 * @param opts.error - Optional error message shown above the roster
 */
export function renderRecipientsHtml(opts: {
  recipients: Recipient[];
  error?: string;
}): string {
  const error =
    opts.error === undefined ? '' : `<p class="error">${slot(opts.error)}</p>`;
  const roster =
    opts.recipients.length === 0
      ? '<div class="card"><p class="muted">No recipients</p></div>'
      : `<div class="card">
          <ul class="roster">
            ${opts.recipients.map(renderRow).join('\n            ')}
          </ul>
        </div>`;
  const body = `<div class="wrap">
      <div class="topbar">
        <div>
          <p class="brand">21.gifts</p>
          <h1>Recipients</h1>
        </div>
        <form method="post" action="/logout"><button class="ghost" type="submit">Log out</button></form>
      </div>
      ${error}
      ${roster}
      <h2>Add recipient</h2>
      <form class="card add-grid" method="post" action="/recipients/add">
        <p class="grow"><label>Address<br><input name="address" type="text" autocomplete="off"></label></p>
        <p class="usd"><label>USD<br><input name="amountUsd" type="text" inputmode="decimal"></label></p>
        <p><button class="primary" type="submit">Add</button></p>
      </form>
    </div>`;
  return renderDocument({ title: '21.gifts spend recipients', body });
}
