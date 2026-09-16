import { describe, expect, it } from 'vitest';
import { parseLightningAddress } from '../lightning-address';

describe('parseLightningAddress', () => {
  it('accepts name@domain', () => {
    expect(parseLightningAddress('alice@walletofsatoshi.com')).toBe(
      'alice@walletofsatoshi.com',
    );
    expect(parseLightningAddress('  alice@walletofsatoshi.com  ')).toBe(
      'alice@walletofsatoshi.com',
    );
  });

  it('rejects empty local or empty domain', () => {
    expect(parseLightningAddress('@domain')).toBeNull();
    expect(parseLightningAddress('local@')).toBeNull();
    expect(parseLightningAddress('')).toBeNull();
    expect(parseLightningAddress('not-an-address')).toBeNull();
  });
});
