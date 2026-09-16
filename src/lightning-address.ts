/**
 * Trim and require a Lightning Address of the form `name@domain`.
 *
 * @param raw - Candidate address.
 * @returns Trimmed address, or `null` when local or domain is empty.
 */
export function parseLightningAddress(raw: string): string | null {
  const address = raw.trim();
  const at = address.indexOf('@');
  if (at <= 0 || at === address.length - 1) {
    return null;
  }
  return address;
}
