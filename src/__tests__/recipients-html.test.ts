import { describe, expect, it } from 'vitest';
import { renderLoginHtml, renderRecipientsHtml, renderUnconfiguredHtml } from '../recipients-html';

describe('renderLoginHtml', () => {
  it('renders the form, an error, and the disabled state', () => {
    const form = renderLoginHtml({});
    expect(form).toContain('<title>21.gifts spend</title>');
    expect(form).toContain('action="/"');
    expect(form).toContain('name="password"');
    expect(form).toContain('Log in');
    expect(form).toContain('class="card login-form"');
    expect(form).toContain('<span>Password</span>');
    const loginBody = form.slice(form.indexOf('<body>'));
    expect(loginBody).not.toContain('<br>');
    expect(loginBody).not.toContain('add-grid');
    expect(renderLoginHtml({ error: 'Invalid password' })).toContain('Invalid password');
    expect(renderLoginHtml({ disabled: true })).toContain('Recipient editor is not configured');
    expect(renderLoginHtml({ disabled: true })).not.toContain('name="password"');
  });
});

describe('renderRecipientsHtml', () => {
  it('renders rows, escapes HTML, and the empty state', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com', amountUsd: 1.5 }],
      error: 'Address already listed',
    });
    expect(html).toContain('<title>21.gifts spend</title>');
    expect(html).toContain('a@b.com');
    expect(html).toContain('value="1.5"');
    expect(html).toContain('action="/recipients/update"');
    expect(html).toContain('action="/recipients/delete"');
    expect(html).toContain('action="/recipients/add"');
    expect(html).toContain('action="/logout"');
    expect(html).toContain('Address already listed');
    expect(html).not.toContain('href="/"');
    expect(html).toMatch(/class="addr"[^>]*>a@b\.com</);
    const escaped = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com"><img>', amountUsd: 1 }],
    });
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('&lt;img&gt;');
    const empty = renderRecipientsHtml({ recipients: [] });
    expect(empty).toContain('No recipients');
    expect(empty).toContain('class="card add-grid"');
    expect(empty).toContain('<span>Address</span>');
    expect(empty).toContain('<span>USD</span>');
    const addForm = empty.slice(empty.indexOf('action="/recipients/add"'));
    expect(addForm).not.toContain('<br>');
  });

  it('abbreviates Wallet of Satoshi in .addr and uses icon buttons', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
    });
    expect(html).toMatch(/class="addr"[^>]*>alice@w\.\.\.</);
    expect(html).toContain('title="alice@walletofsatoshi.com"');
    expect(html).toContain('value="alice@walletofsatoshi.com"');
    expect(html).not.toContain('>Update<');
    expect(html).not.toContain('>Delete<');
    expect(html).toContain('aria-label="Update alice@walletofsatoshi.com"');
    expect(html).toContain('aria-label="Delete alice@walletofsatoshi.com"');
    expect(html).toContain('aria-label="USD amount for alice@walletofsatoshi.com"');
  });

  it('appends a non-editable Total row summing USD amounts', () => {
    const html = renderRecipientsHtml({
      recipients: [
        { address: 'a@b.com', amountUsd: 1.5 },
        { address: 'c@d.com', amountUsd: 2 },
      ],
    });
    expect(html).toContain('class="row total"');
    expect(html).toContain('>Total</span>');
    expect(html).toContain('class="usd-total">3.5<');
    const totalStart = html.indexOf('class="row total"');
    const totalLi = html.slice(totalStart, html.indexOf('</li>', totalStart));
    expect(totalLi).not.toContain('action="/recipients/update"');
    expect(totalLi).not.toContain('action="/recipients/delete"');
    expect(totalLi).not.toContain('name="amountUsd"');
    expect(totalLi).not.toContain('aria-label="Total USD"');
    expect(html).toContain('action="/recipients/update"');
    expect(html).toContain('action="/recipients/delete"');
    expect(html).toContain('name="amountUsd"');
  });

  it('rounds binary float sums to cents', () => {
    const html = renderRecipientsHtml({
      recipients: [
        { address: 'a@b.com', amountUsd: 0.1 },
        { address: 'c@d.com', amountUsd: 0.2 },
      ],
    });
    expect(html).toContain('class="usd-total">0.3<');
    expect(html).not.toContain('0.30000000000000004');
  });

  it('drops trailing zeros on integer totals', () => {
    const html = renderRecipientsHtml({
      recipients: [
        { address: 'a@b.com', amountUsd: 1 },
        { address: 'c@d.com', amountUsd: 2 },
      ],
    });
    expect(html).toContain('class="usd-total">3<');
    expect(html).not.toContain('class="usd-total">3.00<');
  });

  it('omits the Total row when the roster is empty', () => {
    const empty = renderRecipientsHtml({ recipients: [] });
    expect(empty).toContain('No recipients');
    expect(empty).not.toContain('class="row total"');
  });
});

describe('renderUnconfiguredHtml', () => {
  it('shows the muted notice with a loaded spend block', () => {
    const html = renderUnconfiguredHtml({
      sats: 10,
      usd: 1,
      lightningAddress: 'x@y.com',
    });
    expect(html).toContain('<title>21.gifts spend</title>');
    expect(html).toContain('Recipient editor is not configured');
    expect(html).toContain('10 sats');
    expect(html).toContain('x@y.com');
    expect(html).not.toContain('name="password"');
  });
});
