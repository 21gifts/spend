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
    expect(form).not.toContain('action="/recipients/comment"');
    expect(form).not.toContain('name="comment"');
    expect(form).not.toContain('Payment comment');
    expect(form).not.toContain('action="/recipients/payments"');
    expect(form).not.toContain('action="/moderators/payments"');
    expect(renderLoginHtml({ error: 'Invalid password' })).toContain('Invalid password');
    expect(renderLoginHtml({ disabled: true })).toContain('Recipient editor is not configured');
    expect(renderLoginHtml({ disabled: true })).not.toContain('name="password"');
    expect(renderLoginHtml({ disabled: true })).not.toContain('action="/recipients/comment"');
    expect(renderLoginHtml({ disabled: true })).not.toContain('name="comment"');
    expect(renderLoginHtml({ disabled: true })).not.toContain('Payment comment');
    expect(renderLoginHtml({ disabled: true })).not.toContain('action="/recipients/payments"');
    expect(renderLoginHtml({ disabled: true })).not.toContain('action="/moderators/payments"');
  });
});

describe('renderRecipientsHtml', () => {
  it('renders rows, escapes HTML, and the empty state', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com', amountUsd: 1.5 }],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
      error: 'Address already listed',
    });
    expect(html).toContain('<title>21.gifts spend</title>');
    expect(html).toContain('a@b.com');
    expect(html).toContain('value="1.5"');
    expect(html).toContain('action="/recipients/update"');
    expect(html).toContain('action="/recipients/delete"');
    expect(html).toContain('action="/recipients/add"');
    expect(html).toContain('action="/moderators/add"');
    expect(html).toContain('<h2>Moderators</h2>');
    expect(html).toContain('No moderators');
    expect(html).toContain('<h2>Add moderator</h2>');
    expect(html).toContain('action="/logout"');
    expect(html).toContain('Payment comment');
    expect(html).toContain('action="/recipients/comment"');
    expect(html).toContain('name="comment"');
    expect(html).toContain('Save');
    expect(html).toContain('>21gifts daily</textarea>');
    expect(html).toContain('Address already listed');
    expect(html).not.toContain('href="/"');
    expect(html).toMatch(/class="addr"[^>]*>a@b\.com</);
    const escaped = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com"><img>', amountUsd: 1 }],
      moderators: [],
      comment: '</textarea><script>alert(1)</script>&"',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('&lt;img&gt;');
    expect(escaped).toContain(
      '&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;',
    );
    expect(escaped).not.toContain('</textarea><script>');
    const empty = renderRecipientsHtml({
      recipients: [],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(empty).toContain('No recipients');
    expect(empty).toContain('No moderators');
    expect(empty).toContain('Payment comment');
    expect(empty).toContain('action="/recipients/comment"');
    expect(empty).toContain('name="comment"');
    expect(empty).toContain('Save');
    expect(empty).toContain('>21gifts daily</textarea>');
    expect(empty).toContain('class="card add-grid"');
    expect(empty).toContain('<span>Address</span>');
    expect(empty).toContain('<span>USD</span>');
    const addForm = empty.slice(empty.indexOf('action="/recipients/add"'));
    expect(addForm).not.toContain('<br>');
  });

  it('renders Invalid comment above the payment comment form', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
      error: 'Invalid comment',
    });
    const errorAt = html.indexOf('Invalid comment');
    expect(errorAt).toBeGreaterThan(-1);
    expect(errorAt).toBeLessThan(html.indexOf('action="/recipients/comment"'));
    expect(errorAt).toBeLessThan(html.indexOf('<h2>Payment comment</h2>'));
    expect(errorAt).toBeLessThan(html.indexOf('<h2>Recipients</h2>'));
  });

  it('abbreviates Wallet of Satoshi in .addr and uses icon buttons', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
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
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
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
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
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
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(html).toContain('class="usd-total">3<');
    expect(html).not.toContain('class="usd-total">3.00<');
  });

  it('omits the Total row when the roster is empty', () => {
    const empty = renderRecipientsHtml({
      recipients: [],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(empty).toContain('No recipients');
    expect(empty).toContain('No moderators');
    expect(empty).not.toContain('class="row total"');
  });

  it('renders a non-empty moderator roster and unique aria-labels when an address is on both lists', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
      moderators: [
        { address: 'a@b.com', amountUsd: 5 },
        { address: 'm@x.com', amountUsd: 2.5 },
      ],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(html).toContain('<h2>Moderators</h2>');
    expect(html).toContain('action="/moderators/update"');
    expect(html).toContain('action="/moderators/delete"');
    expect(html).toContain('action="/moderators/add"');
    expect(html).not.toContain('No moderators');
    expect(html).toContain('aria-label="USD amount for a@b.com"');
    expect(html).toContain('aria-label="Update a@b.com"');
    expect(html).toContain('aria-label="Delete a@b.com"');
    expect(html).toContain('aria-label="USD amount for moderator a@b.com"');
    expect(html).toContain('aria-label="Update moderator a@b.com"');
    expect(html).toContain('aria-label="Delete moderator a@b.com"');
    expect(html).toContain('aria-label="USD amount for moderator m@x.com"');
    expect(html).toContain('class="usd-total">1<');
    expect(html).toContain('class="usd-total">7.5<');
  });

  it('renders empty recipients with a moderator Total row', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [{ address: 'm@x.com', amountUsd: 5 }],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(html).toContain('No recipients');
    expect(html).not.toContain('No moderators');
    expect(html).toContain('class="usd-total">5<');
    expect(html).toContain('action="/moderators/update"');
  });

  it('places On/Off switches after each heading and before that roster card', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
      moderators: [{ address: 'm@x.com', amountUsd: 5 }],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    const recH2 = html.indexOf('<h2>Recipients</h2>');
    const dailySwitch = html.indexOf('aria-label="Daily payments"');
    const recUpdate = html.indexOf('action="/recipients/update"');
    expect(recH2).toBeGreaterThan(-1);
    expect(dailySwitch).toBeGreaterThan(recH2);
    expect(recUpdate).toBeGreaterThan(dailySwitch);
    const modH2 = html.indexOf('<h2>Moderators</h2>');
    const modSwitch = html.indexOf('aria-label="Moderator payments"');
    const modUpdate = html.indexOf('action="/moderators/update"');
    expect(modH2).toBeGreaterThan(-1);
    expect(modSwitch).toBeGreaterThan(modH2);
    expect(modUpdate).toBeGreaterThan(modSwitch);
  });

  it('presses On on both switches when both flags are true, including empty rosters', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    const daily = formByAriaLabel(html, 'Daily payments');
    expect(daily).toContain('action="/recipients/payments"');
    expect(daily).toContain('class="switch-label">Payments</span>');
    expect(daily).toContain(
      '<button type="submit" name="enabled" value="on" class="primary" aria-pressed="true">On</button>',
    );
    expect(daily).toContain(
      '<button type="submit" name="enabled" value="off" class="ghost" aria-pressed="false">Off</button>',
    );
    const moderator = formByAriaLabel(html, 'Moderator payments');
    expect(moderator).toContain('action="/moderators/payments"');
    expect(moderator).toContain('class="switch-label">Payments</span>');
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="on" class="primary" aria-pressed="true">On</button>',
    );
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="off" class="ghost" aria-pressed="false">Off</button>',
    );
    expect(html).toContain('No recipients');
    expect(html).toContain('No moderators');
    const recH2 = html.indexOf('<h2>Recipients</h2>');
    const dailySwitch = html.indexOf('aria-label="Daily payments"');
    const noRecipients = html.indexOf('No recipients');
    expect(dailySwitch).toBeGreaterThan(recH2);
    expect(noRecipients).toBeGreaterThan(dailySwitch);
    const modH2 = html.indexOf('<h2>Moderators</h2>');
    const modSwitch = html.indexOf('aria-label="Moderator payments"');
    const noModerators = html.indexOf('No moderators');
    expect(modSwitch).toBeGreaterThan(modH2);
    expect(noModerators).toBeGreaterThan(modSwitch);
  });

  it('presses Off on the daily switch when paymentsEnabled is false', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: true,
    });
    const daily = formByAriaLabel(html, 'Daily payments');
    expect(daily).toContain(
      '<button type="submit" name="enabled" value="on" class="ghost" aria-pressed="false">On</button>',
    );
    expect(daily).toContain(
      '<button type="submit" name="enabled" value="off" class="primary" aria-pressed="true">Off</button>',
    );
    const moderator = formByAriaLabel(html, 'Moderator payments');
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="on" class="primary" aria-pressed="true">On</button>',
    );
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="off" class="ghost" aria-pressed="false">Off</button>',
    );
  });

  it('presses Off on the moderator switch when moderatorPaymentsEnabled is false, including an empty daily roster', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [{ address: 'm@x.com', amountUsd: 5 }],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: false,
    });
    const daily = formByAriaLabel(html, 'Daily payments');
    expect(daily).toContain(
      '<button type="submit" name="enabled" value="on" class="primary" aria-pressed="true">On</button>',
    );
    expect(daily).toContain(
      '<button type="submit" name="enabled" value="off" class="ghost" aria-pressed="false">Off</button>',
    );
    const moderator = formByAriaLabel(html, 'Moderator payments');
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="on" class="ghost" aria-pressed="false">On</button>',
    );
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="off" class="primary" aria-pressed="true">Off</button>',
    );
    expect(html).toContain('No recipients');
  });

  it('presses Off on both switches when both flags are false and both rosters are empty', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
    });
    const daily = formByAriaLabel(html, 'Daily payments');
    expect(daily).toContain(
      '<button type="submit" name="enabled" value="off" class="primary" aria-pressed="true">Off</button>',
    );
    const moderator = formByAriaLabel(html, 'Moderator payments');
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="off" class="primary" aria-pressed="true">Off</button>',
    );
    expect(html).toContain('No recipients');
    expect(html).toContain('No moderators');
  });
});

function formByAriaLabel(html: string, label: string): string {
  const marker = `aria-label="${label}"`;
  const attrAt = html.indexOf(marker);
  expect(attrAt).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<form', attrAt);
  const end = html.indexOf('</form>', attrAt);
  return html.slice(start, end + '</form>'.length);
}

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
    expect(html).not.toContain('action="/recipients/comment"');
    expect(html).not.toContain('name="comment"');
    expect(html).not.toContain('Payment comment');
    expect(html).not.toContain('action="/recipients/payments"');
    expect(html).not.toContain('action="/moderators/payments"');
  });
});
