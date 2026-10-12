import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addressRef, redactAddresses, redactLogFields } from '../log-redact';

const KEY = 'test-token';
const ADDRESS = 'alice@example.com';

describe('addressRef', () => {
  it('equals an independently computed HMAC-SHA256 prefix', () => {
    const expected = createHmac('sha256', KEY).update('alice@example.com').digest('hex').slice(0, 12);
    expect(addressRef(ADDRESS, KEY)).toBe(expected);
  });

  it('is 12 lower-case hex characters', () => {
    expect(addressRef(ADDRESS, KEY)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is identical for mixed-case and lower-case addresses', () => {
    expect(addressRef('Alice@Example.com', KEY)).toBe(addressRef('alice@example.com', KEY));
  });

  it('differs for a different key', () => {
    expect(addressRef(ADDRESS, KEY)).not.toBe(addressRef(ADDRESS, 'other-token'));
  });

  it('differs for a different address', () => {
    expect(addressRef(ADDRESS, KEY)).not.toBe(addressRef('bob@example.com', KEY));
  });
});

describe('redactAddresses', () => {
  it('replaces one address inside surrounding text', () => {
    expect(redactAddresses('failed for alice@example.com today')).toBe('failed for [address] today');
  });

  it('replaces several addresses', () => {
    expect(redactAddresses('alice@example.com and bob@x.com')).toBe('[address] and [address]');
  });

  it('replaces the whole token containing the address in a quoted JSON-ish string', () => {
    const result = redactAddresses('{"error":"pay alice@example.com"}');
    expect(result).toBe('{"error":"pay [address]');
    expect(result).not.toContain('@');
    expect(result).not.toContain('alice');
    expect(result).not.toContain('example.com');
  });

  it('replaces a whole token that contains an apostrophe and @', () => {
    expect(redactAddresses("failed for o'reilly@example.com today")).toBe('failed for [address] today');
  });

  it('replaces a whole token that contains a quote and @', () => {
    expect(redactAddresses('x foo"@bar.com y')).toBe('x [address] y');
  });

  it('replaces a whole token that contains more than one @', () => {
    expect(redactAddresses('x a@b@c.com y')).toBe('x [address] y');
  });

  it('leaves text without @ unchanged', () => {
    expect(redactAddresses('no email here')).toBe('no email here');
  });
});

describe('redactLogFields', () => {
  it('redacts string values, keeps numbers and booleans, and does not mutate its input', () => {
    const fields = {
      error: 'failed for alice@example.com',
      count: 3,
      ok: true,
    };
    const original = { ...fields };
    const out = redactLogFields(fields);
    expect(out).toEqual({
      error: 'failed for [address]',
      count: 3,
      ok: true,
    });
    expect(fields).toEqual(original);
  });
});
