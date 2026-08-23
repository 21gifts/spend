import { createHash } from 'node:crypto';

/**
 * SHA-256 of a 32-byte hex preimage, as lowercase hex.
 *
 * @param preimageHex - Payment preimage.
 * @returns 64-char hash, or `null` when the input is not 32-byte hex.
 */
export function hashPreimage(preimageHex: string): string | null {
  const hex = preimageHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return null;
  }
  return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
}
