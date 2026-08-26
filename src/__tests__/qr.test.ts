import { describe, it, expect } from 'vitest';
import { bitcoinQrSvg } from '../qr';

describe('bitcoinQrSvg', () => {
  it('returns an svg for an address', () => {
    const svg = bitcoinQrSvg('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });
});
