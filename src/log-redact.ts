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

const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove Lightning addresses from free text.
 * Each known address is replaced exactly (any letter case) with `[address]`.
 * If the text still contains `@`, or the part before or after the `@` of a known address as a
 * word of its own, the whole text becomes `[address]`, because the extent of what must go is then unknown.
 *
 * @param text - Free-text that may embed a Lightning address.
 * @param known - Addresses in scope: replaced exactly first, then their parts are looked for.
 * @returns Text without those addresses and without their parts.
 */
export function redactAddresses(text: string, known: readonly string[] = []): string {
  let out = text;
  const parts: string[] = [];
  for (const needle of [...known].sort((a, b) => b.length - a.length)) {
    if (needle !== '') {
      out = out.replace(new RegExp(escapeRegExp(needle), 'gi'), '[address]');
      const at = needle.lastIndexOf('@');
      parts.push(needle.slice(0, Math.max(at, 0)).trim(), needle.slice(at + 1).trim());
    }
  }
  const rest = out.split('[address]').join(' ');
  const partLeft = parts.some(
    (part) => part !== '' && new RegExp(`(?<![a-z0-9])${escapeRegExp(part)}(?![a-z0-9])`, 'i').test(rest),
  );
  return rest.includes('@') || partLeft ? '[address]' : out;
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
