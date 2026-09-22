import { describe, it, expect } from 'vitest';
import { lightningQrPayload, loadDashboard } from '../dashboard';
import { renderDashboardHtml } from '../recipients-html';

describe('lightningQrPayload', () => {
  it('prefixes lightning:', () => {
    expect(lightningQrPayload('9643e3@lightning.space')).toBe('lightning:9643e3@lightning.space');
  });
});

describe('loadDashboard', () => {
  it('converts sats to USD with the spot price', async () => {
    const data = await loadDashboard({
      lndhub: {
        auth: async () => 'tok',
        balance: async () => 100_000_000,
      },
      btcUsd: async () => 50_000,
      lightningAddress: '9643e3@lightning.space',
    });
    expect(data).toEqual({
      sats: 100_000_000,
      usd: 50_000,
      lightningAddress: '9643e3@lightning.space',
    });
  });

  it('leaves usd null when spot is missing', async () => {
    const data = await loadDashboard({
      lndhub: {
        auth: async () => 'tok',
        balance: async () => 1000,
      },
      btcUsd: async () => null,
      lightningAddress: null,
    });
    expect(data.usd).toBeNull();
    expect(data.sats).toBe(1000);
    expect(data.lightningAddress).toBeNull();
  });

  it('keeps the lightning address when balance throws', async () => {
    const data = await loadDashboard({
      lndhub: {
        auth: async () => 'tok',
        balance: async () => {
          throw new Error('balance failed');
        },
      },
      btcUsd: async () => 50_000,
      lightningAddress: '9643e3@lightning.space',
    });
    expect(data.sats).toBeNull();
    expect(data.usd).toBeNull();
    expect(data.lightningAddress).toBe('9643e3@lightning.space');
  });
});

describe('renderDashboardHtml', () => {
  it('shows sats, usd, lightning address, and a qr svg', () => {
    const html = renderDashboardHtml({
      sats: 3803,
      usd: 3.0,
      lightningAddress: '9643e3@lightning.space',
    });
    expect(html).toContain('3803 sats');
    expect(html).toContain('3.00 USD');
    expect(html).toContain('Lightning address');
    expect(html).toContain('9643e3@lightning.space');
    expect(html).toContain('<svg');
    expect(html).not.toContain('Deposit address');
    expect(html).not.toContain('/login');
    expect(html).not.toContain('/recipients');
    expect(html).not.toContain('Log in');
  });

  it('does not abbreviate a Wallet of Satoshi spend address', () => {
    const html = renderDashboardHtml({
      sats: 1,
      usd: 1,
      lightningAddress: 'alice@walletofsatoshi.com',
    });
    expect(html).toContain('alice@walletofsatoshi.com');
    expect(html).not.toContain('alice@w...');
  });

  it('shows unavailable when values are null', () => {
    const html = renderDashboardHtml({ sats: null, usd: null, lightningAddress: null });
    expect(html).toContain('unavailable');
    expect(html).not.toContain('<svg');
  });

  it('escapes a hostile address in HTML text', () => {
    const html = renderDashboardHtml({
      sats: 1,
      usd: 1,
      lightningAddress: '<script>alert(1)</script>',
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('with login panel includes the form and still shows sats/address', () => {
    const html = renderDashboardHtml(
      {
        sats: 3803,
        usd: 3.0,
        lightningAddress: '9643e3@lightning.space',
      },
      { kind: 'login' },
    );
    expect(html).toContain('name="password"');
    expect(html).toContain('Log in');
    expect(html).toContain('action="/"');
    expect(html).toContain('3803 sats');
    expect(html).toContain('9643e3@lightning.space');
  });

  it('with editor panel includes Log out, abbreviated WoS, and dashboard sats', () => {
    const html = renderDashboardHtml(
      {
        sats: 3803,
        usd: 3.0,
        lightningAddress: '9643e3@lightning.space',
      },
      {
        kind: 'editor',
        recipients: [{ address: 'alice@walletofsatoshi.com', amountUsd: 1 }],
        moderators: [],
        comment: '21gifts daily',
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
      },
    );
    expect(html).toContain('Log out');
    expect(html).toContain('alice@w...');
    expect(html).toContain('3803 sats');
  });
});
