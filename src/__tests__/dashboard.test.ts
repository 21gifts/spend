import { describe, it, expect } from 'vitest';
import { loadDashboard, renderDashboardHtml } from '../dashboard';

describe('loadDashboard', () => {
  it('converts sats to USD with the spot price', async () => {
    const data = await loadDashboard({
      lndhub: {
        auth: async () => 'tok',
        balance: async () => 100_000_000,
        getDepositAddress: async () => 'bc1qabc',
      },
      btcUsd: async () => 50_000,
    });
    expect(data).toEqual({ sats: 100_000_000, usd: 50_000, address: 'bc1qabc' });
  });

  it('leaves usd null when spot is missing', async () => {
    const data = await loadDashboard({
      lndhub: {
        auth: async () => 'tok',
        balance: async () => 1000,
        getDepositAddress: async () => null,
      },
      btcUsd: async () => null,
    });
    expect(data.usd).toBeNull();
    expect(data.sats).toBe(1000);
  });

  it('keeps sats when the deposit address lookup throws', async () => {
    const data = await loadDashboard({
      lndhub: {
        auth: async () => 'tok',
        balance: async () => 3803,
        getDepositAddress: async () => {
          throw new Error('newbtc failed');
        },
      },
      btcUsd: async () => 78883.06,
    });
    expect(data.sats).toBe(3803);
    expect(data.address).toBeNull();
    expect(data.usd).not.toBeNull();
  });
});

describe('renderDashboardHtml', () => {
  it('shows sats, usd, address, and a qr svg', () => {
    const html = renderDashboardHtml({
      sats: 3803,
      usd: 3.0,
      address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    });
    expect(html).toContain('3803 sats');
    expect(html).toContain('3.00 USD');
    expect(html).toContain('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
    expect(html).toContain('<svg');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('recipient');
    expect(html).not.toContain('payout');
  });

  it('shows unavailable when values are null', () => {
    const html = renderDashboardHtml({ sats: null, usd: null, address: null });
    expect(html).toContain('unavailable');
    expect(html).not.toContain('<svg');
  });

  it('escapes a hostile address in HTML text', () => {
    const html = renderDashboardHtml({
      sats: 1,
      usd: 1,
      address: '<script>alert(1)</script>',
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
