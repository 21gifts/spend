import { describe, expect, it } from 'vitest';
import { renderLoginHtml, renderRecipientsHtml } from '../recipients-html';

describe('renderLoginHtml', () => {
  it('renders the form, an error, and the disabled state', () => {
    const form = renderLoginHtml({});
    expect(form).toContain('<title>21.gifts spend login</title>');
    expect(form).toContain('action="/login"');
    expect(form).toContain('name="password"');
    expect(form).toContain('Log in');
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
    expect(html).toContain('<title>21.gifts spend recipients</title>');
    expect(html).toContain('a@b.com');
    expect(html).toContain('value="1.5"');
    expect(html).toContain('action="/recipients/update"');
    expect(html).toContain('action="/recipients/delete"');
    expect(html).toContain('action="/recipients/add"');
    expect(html).toContain('action="/logout"');
    expect(html).toContain('Address already listed');
    expect(html).not.toContain('href="/"');
    const escaped = renderRecipientsHtml({
      recipients: [{ address: 'a@b.com"><img>', amountUsd: 1 }],
    });
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('&lt;img&gt;');
    expect(renderRecipientsHtml({ recipients: [] })).toContain('No recipients');
  });
});
