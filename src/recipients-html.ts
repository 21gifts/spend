import type { Recipient } from './config';

function slot(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const SHELL_STYLE = `body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{text-align:left;padding:0.4rem 0.25rem;vertical-align:top}
th{font-weight:600}
form.inline{display:inline}
input[type=text],input[type=password],input[type=number]{width:100%;max-width:16rem;box-sizing:border-box;padding:0.35rem 0.5rem}
button{margin:0.25rem 0.25rem 0.25rem 0;padding:0.35rem 0.75rem}
.error{color:#b00020;margin:0.75rem 0}
.muted{color:#444;margin:1rem 0}`;

/**
 * Server-rendered login page for the recipient editor.
 *
 * @param opts - Optional error message, or `disabled` when no password is configured.
 * @returns HTML document.
 */
export function renderLoginHtml(opts: { error?: string; disabled?: boolean } = {}): string {
  const title = '21.gifts spend login';
  let body: string;
  if (opts.disabled === true) {
    body = `<p class="muted">Recipient editor is not configured</p>`;
  } else {
    const error =
      opts.error === undefined ? '' : `<p class="error">${slot(opts.error)}</p>`;
    body = `${error}
<form method="post" action="/login">
<label>Password<br><input name="password" type="password" autocomplete="current-password"></label>
<p><button type="submit">Log in</button></p>
</form>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${SHELL_STYLE}
</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>
`;
}

/**
 * Server-rendered editable recipient list.
 *
 * @param opts - Recipients and optional error.
 * @returns HTML document.
 */
export function renderRecipientsHtml(opts: { recipients: Recipient[]; error?: string }): string {
  const title = '21.gifts spend recipients';
  const error =
    opts.error === undefined ? '' : `<p class="error">${slot(opts.error)}</p>`;
  const empty =
    opts.recipients.length === 0 ? `<p class="muted">No recipients</p>` : '';
  const rows = opts.recipients
    .map((row) => {
      const addr = slot(row.address);
      const usd = slot(String(row.amountUsd));
      return `<tr>
<td class="addr">${addr}</td>
<td>
<form class="inline" method="post" action="/recipients/update">
<input type="hidden" name="address" value="${addr}">
<input name="amountUsd" type="text" inputmode="decimal" value="${usd}">
<button type="submit">Update</button>
</form>
</td>
<td>
<form class="inline" method="post" action="/recipients/delete">
<input type="hidden" name="address" value="${addr}">
<button type="submit">Delete</button>
</form>
</td>
</tr>`;
    })
    .join('\n');
  const table =
    opts.recipients.length === 0
      ? ''
      : `<table>
<thead><tr><th>Address</th><th>USD</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${SHELL_STYLE}
.addr{word-break:break-all;font-family:ui-monospace,monospace}
</style>
</head>
<body>
<h1>${title}</h1>
${error}
${empty}
${table}
<h2>Add recipient</h2>
<form method="post" action="/recipients/add">
<p><label>Address<br><input name="address" type="text" autocomplete="off"></label></p>
<p><label>USD amount<br><input name="amountUsd" type="text" inputmode="decimal"></label></p>
<p><button type="submit">Add</button></p>
</form>
<form method="post" action="/logout">
<button type="submit">Log out</button>
</form>
</body>
</html>
`;
}
