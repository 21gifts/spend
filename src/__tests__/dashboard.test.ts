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
    expect(html).not.toContain('recipient');
    expect(html).not.toContain('payout');
  });

  it('shows unavailable when values are null', () => {
    const html = renderDashboardHtml({ sats: null, usd: null, address: null });
    expect(html).toContain('unavailable');
    expect(html).not.toContain('<svg');
  });
});
