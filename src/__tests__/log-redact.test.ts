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
  it('replaces the whole text when an address remains and no known address is given', () => {
    expect(redactAddresses('failed for alice@example.com today')).toBe('[address]');
    expect(redactAddresses('alice@example.com and bob@x.com')).toBe('[address]');
    expect(redactAddresses('{"error":"pay alice@example.com"}')).toBe('[address]');
    expect(redactAddresses("failed for o'reilly@example.com today")).toBe('[address]');
    expect(redactAddresses('x foo"@bar.com y')).toBe('[address]');
    expect(redactAddresses('x a@b@c.com y')).toBe('[address]');
  });

  it('replaces a known address and keeps the surrounding text', () => {
    expect(redactAddresses('failed for alice@example.com today', ['alice@example.com'])).toBe(
      'failed for [address] today',
    );
  });

  it('replaces a whitespace address whose extent is unknown', () => {
    expect(redactAddresses('duplicate recipient address alice smith@x.com')).toBe('[address]');
    expect(redactAddresses('pay alice @ example.com failed')).toBe('[address]');
  });

  it('replaces a known whitespace address and keeps the surrounding text', () => {
    expect(redactAddresses('pay alice @ example.com failed', ['alice @ example.com'])).toBe(
      'pay [address] failed',
    );
  });

  it('replaces a known address in any letter case', () => {
    expect(
      redactAddresses('duplicate recipient address ALICE Smith@X.com', ['alice smith@x.com']),
    ).toBe('duplicate recipient address [address]');
  });

  it('matches a known address with regex metacharacters literally', () => {
    expect(redactAddresses('pay a.b+c@x.com now', ['a.b+c@x.com'])).toBe('pay [address] now');
    expect(redactAddresses('pay axb@x.com now', ['a.b@x.com'])).toBe('[address]');
  });

  it('replaces the longer of two overlapping known addresses first', () => {
    expect(redactAddresses('pay alice@x.com', ['ice@x.com', 'alice@x.com'])).toBe('pay [address]');
  });

  it('replaces the whole text when an unknown address remains next to a known one', () => {
    expect(redactAddresses('alice@example.com and bob@x.com', ['alice@example.com'])).toBe('[address]');
  });

  it('skips an empty known string', () => {
    expect(redactAddresses('failed for alice@example.com today', [''])).toBe('[address]');
    expect(redactAddresses('no email here', [''])).toBe('no email here');
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
      error: '[address]',
      count: 3,
      ok: true,
    });
    expect(fields).toEqual(original);
  });

  it('redacts a string value that contains a whitespace address to exactly [address]', () => {
    expect(redactLogFields({ error: 'alice @ example.com' })).toEqual({
      error: '[address]',
    });
  });
});
