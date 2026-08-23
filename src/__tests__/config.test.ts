import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config';

const env = {
  GIFTS_API_URL: 'https://api.21.gifts/',
  GIFTS_API_TOKEN: 'tok',
  LNDHUB_URI: 'lndhub://admin:key@https://lightning.space/lndhub',
};

const file = JSON.stringify({
  comment: '21gifts daily',
  recipients: [{ address: 'a@b.com', amountSats: 1000, comment: 'x' }],
});

describe('loadConfig', () => {
  it('loads env and recipients', () => {
    const loaded = loadConfig(env, () => file);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.giftsApiUrl).toBe('https://api.21.gifts');
      expect(loaded.config.recipients[0]?.comment).toBe('x');
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
      loadConfig(env, () => JSON.stringify({ recipients: [{ address: 'a@b.com', amountSats: 0 }] })).ok,
    ).toBe(false);
  });

  it('rejects duplicate addresses', () => {
    expect(
      loadConfig(
        env,
        () =>
          JSON.stringify({
            recipients: [
              { address: 'a@b.com', amountSats: 1 },
              { address: 'a@b.com', amountSats: 2 },
            ],
          }),
      ).ok,
    ).toBe(false);
  });
});
