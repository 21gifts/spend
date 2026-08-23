import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { hashPreimage } from '../proof';

const PREIMAGE = '11'.repeat(32);

describe('hashPreimage', () => {
  it('hashes a 32-byte preimage', () => {
    expect(hashPreimage(PREIMAGE)).toBe(
      createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex'),
    );
  });

  it('rejects malformed hex', () => {
    expect(hashPreimage('zz')).toBeNull();
  });
});
