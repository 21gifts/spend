import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/** Session cookie name. */
export const SESSION_COOKIE = 'spend_session';

/** Session lifetime in seconds (12 hours). */
export const SESSION_TTL_SEC = 12 * 60 * 60;

/**
 * Mint a signed `spend_session` cookie value (`v1.<expUnix>.<hex mac>`).
 * The password is the HMAC key and is never placed in the cookie.
 *
 * @param password - Dashboard password.
 * @param now - Clock returning unix seconds (default: `Date.now()/1000`).
 * @returns Cookie value (not a full Set-Cookie header).
 */
export function mintSessionCookie(password: string, now: () => number = () => Date.now() / 1000): string {
  const expUnix = Math.floor(now()) + SESSION_TTL_SEC;
  const mac = createHmac('sha256', password).update(`v1|${expUnix}`).digest('hex');
  return `v1.${expUnix}.${mac}`;
}

/**
 * Build a `Set-Cookie` header for the session cookie.
 *
 * Attributes: `HttpOnly`, `SameSite=Strict`, `Path=/`.
 * Adds `Secure` when the request is HTTPS (`url.protocol === 'https:'`) or
 * `x-forwarded-proto` is `https` (e.g. Cloudflare).
 *
 * @param value - Cookie value from {@link mintSessionCookie} or clear value.
 * @param req - Incoming request (scheme + forwarded proto).
 * @param maxAgeSec - `Max-Age` in seconds (`0` clears).
 * @returns Full `Set-Cookie` header value.
 */
export function sessionCookieHeader(value: string, req: Request, maxAgeSec: number): string {
  const url = new URL(req.url);
  const forwarded = req.headers.get('x-forwarded-proto');
  const secure = url.protocol === 'https:' || forwarded === 'https';
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Expired Set-Cookie value that clears the session.
 *
 * @returns Cookie value with empty body (pair with Max-Age=0).
 */
export function clearSessionCookie(): string {
  return '';
}

/**
 * Compare a submitted password to the configured password using SHA-256 digests
 * so lengths always match for `timingSafeEqual`. Rejects empty submitted.
 *
 * @param configured - Stored dashboard password.
 * @param submitted - Form password.
 * @returns Whether they match.
 */
export function passwordsMatch(configured: string, submitted: string): boolean {
  if (submitted === '') {
    return false;
  }
  const a = createHash('sha256').update(configured, 'utf8').digest();
  const b = createHash('sha256').update(submitted, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Parse a `Cookie` header and return true if it contains a valid, unexpired session.
 *
 * @param cookieHeader - Raw `Cookie` header or null.
 * @param password - Dashboard password (HMAC key).
 * @param now - Clock returning unix seconds.
 * @returns Whether the session is authenticated.
 */
export function sessionCookieValid(
  cookieHeader: string | null,
  password: string,
  now: () => number = () => Date.now() / 1000,
): boolean {
  if (cookieHeader === null || cookieHeader === '') {
    return false;
  }
  const value = readCookieValue(cookieHeader, SESSION_COOKIE);
  if (value === null) {
    return false;
  }
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return false;
  }
  const expRaw = parts[1];
  const macHex = parts[2];
  /* v8 ignore next 3 — length===3 plus noUncheckedIndexedAccess */
  if (expRaw === undefined || macHex === undefined) {
    return false;
  }
  const expUnix = Number(expRaw);
  if (!Number.isInteger(expUnix) || expUnix <= Math.floor(now())) {
    return false;
  }
  if (!/^[0-9a-f]+$/i.test(macHex) || macHex.length % 2 !== 0) {
    return false;
  }
  const expected = createHmac('sha256', password).update(`v1|${expUnix}`).digest();
  const provided = Buffer.from(macHex, 'hex');
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

function readCookieValue(header: string, name: string): string | null {
  const parts = header.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}
