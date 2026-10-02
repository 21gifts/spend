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
    expect(form).not.toContain('https://21.gifts/grants/payments/');
    expect(renderLoginHtml({ disabled: true })).not.toContain('https://21.gifts/grants/payments/');
  });
});

function expectDailyLinks(html: string): void {
  const textAt = html.indexOf('href="https://21.gifts/grants/payments/comment"');
  const amountsAt = html.indexOf('href="https://21.gifts/grants/payments/amounts"');
  const moderatorsAt = html.indexOf('<h2>Moderators</h2>');
  expect(textAt).toBeGreaterThan(-1);
  expect(html).toContain('>Daily payment text</a>');
  expect(amountsAt).toBeGreaterThan(textAt);
  expect(html).toContain('>Daily payment amounts</a>');
  expect(moderatorsAt).toBeGreaterThan(amountsAt);
}

function expectNoDailyEditor(html: string): void {
  expect(html).not.toContain('Payment comment');
  expect(html).not.toContain('action="/recipients/comment"');
  expect(html).not.toContain('action="/recipients/payments"');
  expect(html).not.toContain('action="/recipients/add"');
  expect(html).not.toContain('action="/recipients/update"');
  expect(html).not.toContain('action="/recipients/delete"');
  expect(html).not.toContain('<h2>Recipients</h2>');
  expect(html).not.toContain('<h2>Add recipient</h2>');
  expect(html).not.toContain('aria-label="Daily payments"');
}

describe('renderRecipientsHtml', () => {
  it('renders moderator rows, escapes HTML, and the empty state', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com', amountUsd: 1.5 }],
      moderators: [{ address: 'm@x.com', amountUsd: 1.5 }],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
      error: 'Address already listed',
    });
    expect(html).toContain('<title>21.gifts spend</title>');
    expect(html).toContain('m@x.com');
    expect(html).toContain('value="1.5"');
    expect(html).toContain('action="/moderators/update"');
    expect(html).toContain('action="/moderators/delete"');
    expect(html).toContain('action="/moderators/add"');
    expect(html).toContain('<h2>Moderators</h2>');
    expectDailyLinks(html);
    expect(html).not.toContain('No moderators');
    expect(html).toContain('<h2>Add moderator</h2>');
    expect(html).toContain('action="/logout"');
    expect(html).toContain('Address already listed');
    expect(html).not.toContain('href="/"');
    expect(html).toMatch(/class="addr"[^>]*>m@x\.com</);
    expectNoDailyEditor(html);
    expect(html).not.toContain('a@b.com');
    const escaped = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com"><img>', amountUsd: 1 }],
      moderators: [{ address: 'a@b.com"><img>', amountUsd: 1 }],
      comment: '</textarea><script>alert(1)</script>&"',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('&lt;img&gt;');
    expect(escaped).not.toContain('<img>');
    const empty = renderRecipientsHtml({
      recipients: [],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(empty).toContain('No moderators');
    expect(empty).not.toContain('No recipients');
    expectNoDailyEditor(empty);
    expect(empty).toContain('class="card add-grid"');
    expect(empty).toContain('<span>Address</span>');
    expect(empty).toContain('<span>USD</span>');
    const addForm = empty.slice(empty.indexOf('action="/moderators/add"'));
    expect(addForm).not.toContain('<br>');
  });

  it('renders Invalid comment above the Moderators heading', () => {
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
    expect(errorAt).toBeLessThan(html.indexOf('<h2>Moderators</h2>'));
    expectNoDailyEditor(html);
  });

  it('abbreviates Wallet of Satoshi in .addr and uses icon buttons', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(html).toMatch(/class="addr"[^>]*>alice@w\.\.\.</);
    expect(html).toContain('title="alice@walletofsatoshi.com"');
    expect(html).toContain('value="alice@walletofsatoshi.com"');
    expect(html).not.toContain('>Update<');
    expect(html).not.toContain('>Delete<');
    expect(html).toContain('aria-label="Update moderator alice@walletofsatoshi.com"');
    expect(html).toContain('aria-label="Delete moderator alice@walletofsatoshi.com"');
    expect(html).toContain('aria-label="USD amount for moderator alice@walletofsatoshi.com"');
    expectNoDailyEditor(html);
  });

  it('appends a non-editable Total row summing USD amounts', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [
        { address: 'a@b.com', amountUsd: 1.5 },
        { address: 'c@d.com', amountUsd: 2 },
      ],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(html).toContain('class="row total"');
    expect(html).toContain('>Total</span>');
    expect(html).toContain('class="usd-total">3.5<');
    const totalStart = html.indexOf('class="row total"');
    const totalLi = html.slice(totalStart, html.indexOf('</li>', totalStart));
    expect(totalLi).not.toContain('action="/moderators/update"');
    expect(totalLi).not.toContain('action="/moderators/delete"');
    expect(totalLi).not.toContain('name="amountUsd"');
    expect(totalLi).not.toContain('aria-label="Total USD"');
    expect(html).toContain('action="/moderators/update"');
    expect(html).toContain('action="/moderators/delete"');
    expect(html).toContain('name="amountUsd"');
    expectNoDailyEditor(html);
  });

  it('rounds binary float sums to cents', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [
        { address: 'a@b.com', amountUsd: 0.1 },
        { address: 'c@d.com', amountUsd: 0.2 },
      ],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(html).toContain('class="usd-total">0.3<');
    expect(html).not.toContain('0.30000000000000004');
  });

  it('drops trailing zeros on integer totals', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [
        { address: 'a@b.com', amountUsd: 1 },
        { address: 'c@d.com', amountUsd: 2 },
      ],
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
    expect(empty).not.toContain('No recipients');
    expect(empty).toContain('No moderators');
    expect(empty).not.toContain('class="row total"');
    expectNoDailyEditor(empty);
  });

  it('renders a non-empty moderator roster with moderator aria-labels', () => {
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
    expect(html).not.toContain('aria-label="USD amount for a@b.com"');
    expect(html).not.toContain('aria-label="Update a@b.com"');
    expect(html).not.toContain('aria-label="Delete a@b.com"');
    expect(html).toContain('aria-label="USD amount for moderator a@b.com"');
    expect(html).toContain('aria-label="Update moderator a@b.com"');
    expect(html).toContain('aria-label="Delete moderator a@b.com"');
    expect(html).toContain('aria-label="USD amount for moderator m@x.com"');
    expect(html).toContain('class="usd-total">7.5<');
    expect(html).not.toContain('class="usd-total">1<');
    expectNoDailyEditor(html);
  });

  it('renders a moderator Total row without a daily empty message', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [{ address: 'm@x.com', amountUsd: 5 }],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(html).not.toContain('No recipients');
    expect(html).not.toContain('No moderators');
    expect(html).toContain('class="usd-total">5<');
    expect(html).toContain('action="/moderators/update"');
    expectNoDailyEditor(html);
  });

  it('places the On/Off switch after the Moderators heading and before that roster card', () => {
    const html = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
      moderators: [{ address: 'm@x.com', amountUsd: 5 }],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    const modH2 = html.indexOf('<h2>Moderators</h2>');
    const modSwitch = html.indexOf('aria-label="Moderator payments"');
    const modUpdate = html.indexOf('action="/moderators/update"');
    expect(modH2).toBeGreaterThan(-1);
    expect(modSwitch).toBeGreaterThan(modH2);
    expect(modUpdate).toBeGreaterThan(modSwitch);
    expectNoDailyEditor(html);
  });

  it('presses On on the moderator switch when the flag is true, including an empty roster', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    const moderator = formByAriaLabel(html, 'Moderator payments');
    expect(moderator).toContain('action="/moderators/payments"');
    expect(moderator).toContain('class="switch-label">Payments</span>');
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="on" class="primary" aria-pressed="true">On</button>',
    );
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="off" class="ghost" aria-pressed="false">Off</button>',
    );
    expect(html).not.toContain('No recipients');
    expect(html).toContain('No moderators');
    const modH2 = html.indexOf('<h2>Moderators</h2>');
    const modSwitch = html.indexOf('aria-label="Moderator payments"');
    const noModerators = html.indexOf('No moderators');
    expect(modSwitch).toBeGreaterThan(modH2);
    expect(noModerators).toBeGreaterThan(modSwitch);
    expectNoDailyEditor(html);
  });

  it('presses Off on the moderator switch when moderatorPaymentsEnabled is false', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [{ address: 'm@x.com', amountUsd: 5 }],
      comment: '21gifts daily',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: false,
    });
    const moderator = formByAriaLabel(html, 'Moderator payments');
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="on" class="ghost" aria-pressed="false">On</button>',
    );
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="off" class="primary" aria-pressed="true">Off</button>',
    );
    expect(html).not.toContain('No recipients');
    expectNoDailyEditor(html);
  });

  it('presses Off on the moderator switch when the flag is false and the roster is empty', () => {
    const html = renderRecipientsHtml({
      recipients: [],
      moderators: [],
      comment: '21gifts daily',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
    });
    const moderator = formByAriaLabel(html, 'Moderator payments');
    expect(moderator).toContain(
      '<button type="submit" name="enabled" value="off" class="primary" aria-pressed="true">Off</button>',
    );
    expect(html).not.toContain('No recipients');
    expect(html).toContain('No moderators');
    expectNoDailyEditor(html);
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
