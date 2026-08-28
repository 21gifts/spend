import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config';

const env = {
  GIFTS_API_URL: 'https://api.21.gifts/',
  GIFTS_API_TOKEN: 'tok',
  LNDHUB_URI: 'lndhub://admin:key@https://lightning.space/lndhub',
};

const file = JSON.stringify({
  comment: '21gifts daily',
  recipients: [{ address: 'a@b.com', amountUsd: 1, comment: 'x' }],
});

describe('loadConfig', () => {
  it('loads env and recipients', () => {
    const loaded = loadConfig(env, () => file);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.giftsApiUrl).toBe('https://api.21.gifts');
      expect(loaded.config.recipients[0]?.comment).toBe('x');
      expect(loaded.config.lightningAddress).toBeNull();
      expect(loaded.config.dashboardPassword).toBeNull();
    }
  });

  it('accepts SPEND_LIGHTNING_ADDRESS and rejects a value without @', () => {
    const ok = loadConfig({ ...env, SPEND_LIGHTNING_ADDRESS: ' 9643e3@lightning.space ' }, () => file);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.lightningAddress).toBe('9643e3@lightning.space');
    }
    expect(loadConfig({ ...env, SPEND_LIGHTNING_ADDRESS: 'not-an-address' }, () => file).ok).toBe(false);
  });

  it('trims SPEND_DASHBOARD_PASSWORD and treats blank as null', () => {
    const set = loadConfig({ ...env, SPEND_DASHBOARD_PASSWORD: '  secret  ' }, () => file);
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(set.config.dashboardPassword).toBe('secret');
    }
    const blank = loadConfig({ ...env, SPEND_DASHBOARD_PASSWORD: '   ' }, () => file);
    expect(blank.ok).toBe(true);
    if (blank.ok) {
      expect(blank.config.dashboardPassword).toBeNull();
    }
  });

  it('requires GIFTS_API_URL', () => {
    const loaded = loadConfig({ ...env, GIFTS_API_URL: '' }, () => file);
    expect(loaded.ok).toBe(false);
  });

  it('requires GIFTS_API_TOKEN', () => {
    expect(loadConfig({ ...env, GIFTS_API_TOKEN: '' }, () => file).ok).toBe(false);
  });

  it('requires an lndhub URI', () => {
    expect(loadConfig({ ...env, LNDHUB_URI: 'https://x' }, () => file).ok).toBe(false);
  });

  it('rejects missing recipients file', () => {
    expect(
      loadConfig(env, () => {
        throw new Error('enoent');
      }).ok,
    ).toBe(false);
  });

  it('rejects empty recipient list', () => {
    expect(loadConfig(env, () => JSON.stringify({ recipients: [] })).ok).toBe(false);
  });

  it('rejects bad JSON', () => {
    expect(loadConfig(env, () => '{').ok).toBe(false);
  });

  it('rejects a bad amount', () => {
    expect(
      loadConfig(env, () => JSON.stringify({ recipients: [{ address: 'a@b.com', amountUsd: 0 }] })).ok,
    ).toBe(false);
  });

  it('rejects duplicate addresses', () => {
    expect(
      loadConfig(
        env,
        () =>
          JSON.stringify({
            recipients: [
              { address: 'a@b.com', amountUsd: 1 },
              { address: 'a@b.com', amountUsd: 2 },
            ],
          }),
      ).ok,
    ).toBe(false);
  });

  it('loads recipients.tondo.json', () => {
    const path = fileURLToPath(new URL('../../recipients.tondo.json', import.meta.url));
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      btcUsd: string;
      recipients: { address: string; amountSats: number; amountUsd: number }[];
    };
    const rate = Number(raw.btcUsd);
    expect(raw.recipients).toHaveLength(16);
    expect(raw.recipients.map((r) => r.address)).toContain('piousmenu95@walletofsatoshi.com');
    expect(raw.recipients.reduce((sum, r) => sum + r.amountUsd, 0)).toBe(50);
    expect(raw.recipients.reduce((sum, r) => sum + r.amountSats, 0)).toBe(64021);
    for (const row of raw.recipients) {
      expect(row.amountSats).toBe(Math.round((row.amountUsd / rate) * 1e8));
    }
    const loaded = loadConfig({ ...env, RECIPIENTS_FILE: path }, (file) => readFileSync(file, 'utf8'));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.recipients).toHaveLength(16);
      expect(loaded.config.recipients[0]?.address).toBe('mentalnic63@walletofsatoshi.com');
      expect(loaded.config.recipients[0]?.amountUsd).toBe(3);
      expect(loaded.config.recipients[15]?.address).toBe('bentfresh52@walletofsatoshi.com');
      expect(loaded.config.recipients[15]?.amountUsd).toBe(2.5);
    }
  });
});
