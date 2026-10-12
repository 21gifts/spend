import { createHmac } from 'node:crypto';

/**
 * Keyed reference for a Lightning address in log lines.
 *
 * @param address - Lightning address (`name@domain`).
 * @param key - HMAC key (`GIFTS_API_TOKEN`).
 * @returns First 12 hex characters of HMAC-SHA256 of the lower-cased address.
 */
export function addressRef(address: string, key: string): string {
  return createHmac('sha256', key).update(address.toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * Replace every whitespace-delimited token that contains `@` with `[address]`.
 *
 * @param text - Free-text that may embed a Lightning address.
 * @returns Text with those tokens replaced.
 */
export function redactAddresses(text: string): string {
  return text.replace(/\S*@\S*/g, '[address]');
}

/**
 * Shallow copy of log fields with every string value passed through redactAddresses. Non-strings unchanged.
 *
 * @param fields - Structured log fields.
 * @returns Shallow copy with string values redacted.
 */
export function redactLogFields<T extends Record<string, unknown>>(fields: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === 'string' ? redactAddresses(value) : value;
  }
  return out as T;
}
