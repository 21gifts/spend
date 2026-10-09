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
  const moderatorsAt = html.indexOf('href="https://21.gifts/grants/payments/moderators"');
  expect(textAt).toBeGreaterThan(-1);
  expect(html).toContain('>Daily payment text</a>');
  expect(amountsAt).toBeGreaterThan(textAt);
  expect(html).toContain('>Daily payment amounts</a>');
  expect(moderatorsAt).toBeGreaterThan(amountsAt);
  expect(html).toContain('>Moderator payments</a>');
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
  it('links to the three 21.gifts pages and does not edit moderators', () => {
    const html = renderRecipientsHtml({ error: 'Address already listed' });
    expect(html).toContain('<title>21.gifts spend</title>');
    expectDailyLinks(html);
    expectNoDailyEditor(html);
    expect(html).toContain('action="/logout"');
    expect(html).toContain('Address already listed');
    expect(html).not.toContain('href="/"');
    expect(html).not.toContain('<h2>Moderators</h2>');
    expect(html).not.toContain('<h2>Add moderator</h2>');
    expect(html).not.toContain('No moderators');
    expect(html).not.toContain('action="/moderators/add"');
    expect(html).not.toContain('action="/moderators/update"');
    expect(html).not.toContain('action="/moderators/delete"');
    expect(html).not.toContain('action="/moderators/payments"');
    expect(html).not.toContain('name="address"');
    expect(html).not.toContain('name="amountUsd"');
  });

  it('omits the error line when none is passed', () => {
    const html = renderRecipientsHtml();
    expectDailyLinks(html);
    expect(html).not.toContain('class="error"');
    expectNoDailyEditor(html);
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
    expect(html).not.toContain('action="/recipients/comment"');
    expect(html).not.toContain('name="comment"');
    expect(html).not.toContain('Payment comment');
    expect(html).not.toContain('action="/recipients/payments"');
    expect(html).not.toContain('action="/moderators/payments"');
  });
});
