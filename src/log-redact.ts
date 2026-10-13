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
 * Remove Lightning addresses from free text.
 * Each known address is replaced exactly (any letter case) with `[address]`.
 * If the text still contains `@` afterwards, the whole text becomes `[address]`,
 * because an address may contain whitespace and its extent is then unknown.
 *
 * @param text - Free-text that may embed a Lightning address.
 * @param known - Addresses whose exact spelling is replaced first (any letter case).
 * @returns Text with those addresses replaced.
 */
export function redactAddresses(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const needle of [...known].sort((a, b) => b.length - a.length)) {
    if (needle !== '') {
      out = out.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[address]');
    }
  }
  return out.includes('@') ? '[address]' : out;
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
