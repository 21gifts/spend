import { renderSVG } from 'uqr';

/**
 * SVG QR code for a wallet payload (`lightning:` URI or other text).
 *
 * @param payload - Text to encode (not interpreted).
 * @returns SVG markup.
 */
export function bitcoinQrSvg(payload: string): string {
  return renderSVG(payload, { pixelSize: 8, whiteColor: '#ffffff', blackColor: '#111111' });
}
