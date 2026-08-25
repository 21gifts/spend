import { renderSVG } from 'uqr';

/**
 * SVG QR code for an on-chain Bitcoin address.
 *
 * @param address - Deposit address (raw, not a URI).
 * @returns SVG markup.
 */
export function bitcoinQrSvg(address: string): string {
  return renderSVG(address, { pixelSize: 8, whiteColor: '#ffffff', blackColor: '#111111' });
}
