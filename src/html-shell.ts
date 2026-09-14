/** Escape text for HTML body / attribute context. */
export function slot(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Shared visible label for a Lightning Address (recipient editor and Telegram payout lines).
 * Domain `walletofsatoshi.com` (ASCII, case-insensitive, exact after the last `@`)
 * → `{local}@w...`. No `@` or any other domain → return `address` unchanged.
 *
 * @param address - Lightning address (or any string)
 * @returns Abbreviated label for Wallet of Satoshi, otherwise `address` unchanged
 */
export function displayLightningAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return address;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (domain.toLowerCase() === 'walletofsatoshi.com') {
    return `${local}@w...`;
  }
  return address;
}

/** Shared document CSS for `/`, `/login`, `/recipients`. */
export const SHELL_STYLE = `html,body{margin:0;min-height:100%}
body{
  font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;
  background:#0a090c;
  color:#f5f5f4;
  padding:2rem 1rem 3rem;
}
.wrap{max-width:36rem;margin:0 auto}
.brand{font-size:0.8rem;letter-spacing:0.12em;text-transform:uppercase;color:#f7931a;margin:0 0 0.35rem}
h1{font-size:1.5rem;font-weight:600;letter-spacing:-0.02em;margin:0 0 1.25rem}
h2{font-size:0.85rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin:1.75rem 0 0.75rem}
.card{
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.10);
  border-radius:14px;
  padding:1rem 1rem;
}
.muted{color:rgba(255,255,255,0.55);margin:0.5rem 0}
.error{color:#ff6b6b;margin:0 0 0.75rem}
form.card p,.card > p{margin:0}
label.field{display:flex;flex-direction:column;gap:0.5rem;margin:0}
label.field > span{font-size:0.75rem;letter-spacing:0.04em;color:rgba(255,255,255,0.55);line-height:1.2}
input[type=text],input[type=password]{
  width:100%;box-sizing:border-box;
  background:#141218;color:#f5f5f4;
  border:1px solid rgba(255,255,255,0.14);
  border-radius:10px;padding:0.55rem 0.7rem;font:inherit;
  height:2.75rem
}
input[type=text]:focus,input[type=password]:focus{outline:none;border-color:#f7931a;box-shadow:0 0 0 1px #f7931a}
button.primary{
  background:#f7931a;color:#0a090c;border:0;border-radius:999px;
  font:inherit;font-weight:600;padding:0.55rem 1.1rem;cursor:pointer
}
button.ghost{
  background:transparent;color:rgba(255,255,255,0.7);
  border:1px solid rgba(255,255,255,0.16);border-radius:999px;
  font:inherit;padding:0.4rem 0.9rem;cursor:pointer
}
.roster{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.45rem}
.row{
  display:flex;align-items:center;gap:0.5rem;
  white-space:nowrap;min-height:2.5rem
}
.addr{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:0.92rem;
  word-break:break-all
}
.row .addr{
  flex:1 1 auto;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  word-break:normal
}
form.inline{display:flex;align-items:center;gap:0.35rem;margin:0}
.row input[name=amountUsd]{
  width:4.75rem;text-align:right;
  background:#141218;color:#f5f5f4;
  border:1px solid rgba(255,255,255,0.14);
  border-radius:10px;padding:0.4rem 0.5rem;font:inherit;
  height:auto
}
button.icon{
  display:inline-flex;align-items:center;justify-content:center;
  width:2.1rem;height:2.1rem;padding:0;margin:0;
  background:rgba(255,255,255,0.06);
  border:1px solid rgba(255,255,255,0.12);
  border-radius:10px;color:#f5f5f4;cursor:pointer
}
button.icon.danger{color:#ff8a8a}
button.icon svg{display:block}
.row.total{
  font-weight:600;
  border-top:1px solid rgba(255,255,255,0.10);
  padding-top:0.45rem;
  margin-top:0.25rem
}
.row.total .inline{display:flex;align-items:center;gap:0.35rem;margin:0}
.row.total .usd-total{
  width:4.75rem;text-align:right;box-sizing:border-box;
  background:#141218;color:#f5f5f4;
  border:1px solid rgba(255,255,255,0.14);
  border-radius:10px;padding:0.4rem 0.5rem;font:inherit
}
.row.total .icon-spacer{
  width:2.1rem;height:2.1rem;flex:0 0 2.1rem
}
.qr{
  display:inline-flex;background:#fff;border-radius:16px;padding:0.75rem;margin-top:1rem
}
.qr svg{width:12rem;height:12rem;display:block}
.balance-sats{font-size:2rem;font-weight:600;letter-spacing:-0.03em;margin:0.2rem 0 0}
.balance-usd{color:rgba(255,255,255,0.6);margin:0.25rem 0 1.25rem}
.kicker{font-size:0.75rem;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin:0}
.login-form,.add-grid{display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap}
.login-form .grow,.add-grid .grow{flex:1 1 12rem;min-width:0}
.add-grid .usd{flex:0 0 6.5rem}
.login-form button.primary,.add-grid button.primary{box-sizing:border-box;height:2.75rem;flex:0 0 auto;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center}
.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1rem}`;

/**
 * HTML document: doctype, html lang=en, charset, viewport, title, style (SHELL_STYLE + extraCss), body.
 *
 * @param opts.title - Document title (caller-supplied safe literal; not escaped)
 * @param opts.body - Inner HTML for the body
 * @param opts.extraCss - Optional CSS appended after SHELL_STYLE
 * @returns Complete HTML document string
 */
export function renderDocument(opts: { title: string; body: string; extraCss?: string }): string {
  const style = opts.extraCss === undefined ? SHELL_STYLE : `${SHELL_STYLE}${opts.extraCss}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<style>${style}</style>
</head>
<body>
${opts.body}
</body>
</html>`;
}
