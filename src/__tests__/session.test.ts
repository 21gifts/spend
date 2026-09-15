import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  clearSessionCookie,
  mintSessionCookie,
  passwordsMatch,
  sessionCookieHeader,
  sessionCookieValid,
} from '../session';

describe('passwordsMatch', () => {
  it('accepts equal passwords and rejects empty or different', () => {
    expect(passwordsMatch('secret', 'secret')).toBe(true);
    expect(passwordsMatch('secret', 'Secret')).toBe(false);
    expect(passwordsMatch('secret', '')).toBe(false);
  });
});

describe('session cookie', () => {
  it('uses the wall clock when now is omitted', () => {
    const value = mintSessionCookie('secret');
    expect(sessionCookieValid(`${SESSION_COOKIE}=${value}`, 'secret')).toBe(true);
  });

  it('mints a v1 value that validates until expiry', () => {
    let now = 1_700_000_000;
    const value = mintSessionCookie('secret', () => now);
    expect(value.startsWith('v1.')).toBe(true);
    const header = `${SESSION_COOKIE}=${value}`;
    expect(sessionCookieValid(header, 'secret', () => now)).toBe(true);
    now += SESSION_TTL_SEC + 1;
    expect(sessionCookieValid(header, 'secret', () => now)).toBe(false);
  });

  it('rejects missing, empty, malformed, and wrong-key cookies', () => {
    expect(sessionCookieValid(null, 'secret')).toBe(false);
    expect(sessionCookieValid('', 'secret')).toBe(false);
    expect(sessionCookieValid('other=1', 'secret')).toBe(false);
    expect(sessionCookieValid('spend_session=v1', 'secret')).toBe(false);
    expect(sessionCookieValid('spend_session=v2.1.aa', 'secret')).toBe(false);
    expect(sessionCookieValid('spend_session=v1.nope.aa', 'secret')).toBe(false);
    expect(sessionCookieValid('spend_session=v1.1700000100.zz', 'secret', () => 1_700_000_000)).toBe(
      false,
    );
    expect(sessionCookieValid('spend_session=v1.1700000100.abc', 'secret', () => 1_700_000_000)).toBe(
      false,
    );
    expect(sessionCookieValid('spend_session=v1.1700000100.aa', 'secret', () => 1_700_000_000)).toBe(
      false,
    );
    const value = mintSessionCookie('secret', () => 1_700_000_000);
    expect(sessionCookieValid(`${SESSION_COOKIE}=${value}`, 'other', () => 1_700_000_000)).toBe(
      false,
    );
  });

  it('reads the named cookie among several', () => {
    const value = mintSessionCookie('secret', () => 1_700_000_000);
    expect(
      sessionCookieValid(
        `=skip; a=1; ${SESSION_COOKIE}=${value}; b=2`,
        'secret',
        () => 1_700_000_000,
      ),
    ).toBe(true);
  });

  it('sets Secure only on https or forwarded https', () => {
    const http = sessionCookieHeader('v1.1.aa', new Request('http://127.0.0.1/login'), 10);
    expect(http).not.toContain('Secure');
    expect(http).toContain('HttpOnly');
    expect(http).toContain('SameSite=Strict');
    const https = sessionCookieHeader('v1.1.aa', new Request('https://spend.example/login'), 10);
    expect(https).toContain('Secure');
    const forwarded = sessionCookieHeader(
      'v1.1.aa',
      new Request('http://127.0.0.1/login', { headers: { 'x-forwarded-proto': 'https' } }),
      10,
    );
    expect(forwarded).toContain('Secure');
  });

  it('clears with an empty value', () => {
    expect(clearSessionCookie()).toBe('');
    const header = sessionCookieHeader(clearSessionCookie(), new Request('http://127.0.0.1/'), 0);
    expect(header).toContain('Max-Age=0');
  });
});
