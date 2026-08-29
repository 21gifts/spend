import { describe, expect, it } from 'vitest';
import {
  SHELL_STYLE,
  displayLightningAddress,
  renderDocument,
  slot,
} from '../html-shell';

describe('slot', () => {
  it('escapes &, <, >, and " in that order', () => {
    expect(slot('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e');
  });
});

describe('displayLightningAddress', () => {
  it.each([
    ['alice@walletofsatoshi.com', 'alice@w...'],
    ['Alice@WalletOfSatoshi.COM', 'Alice@w...'],
    ['mentalnic63@walletofsatoshi.com', 'mentalnic63@w...'],
    ['9643e3@lightning.space', '9643e3@lightning.space'],
    ['a@b.com', 'a@b.com'],
    ['no-at-sign', 'no-at-sign'],
    ['user@walletofsatoshi.com.evil', 'user@walletofsatoshi.com.evil'],
  ] as const)('%s → %s', (input, output) => {
    expect(displayLightningAddress(input)).toBe(output);
  });
});

describe('renderDocument', () => {
  it('emits doctype, lang, charset, viewport, title, and body', () => {
    const html = renderDocument({ title: 'Test Title', body: '<p>hello</p>' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(html).toContain('<title>Test Title</title>');
    expect(html).toContain('<p>hello</p>');
  });

  it('appends extraCss when provided', () => {
    const html = renderDocument({
      title: 'X',
      body: '',
      extraCss: '.extra{color:red}',
    });
    expect(html).toContain('.extra{color:red}');
  });

  it('works without extraCss', () => {
    const html = renderDocument({ title: 'Y', body: '<div>ok</div>' });
    expect(html).toContain('<style>');
    expect(html).toContain('</style>');
    expect(html).toContain('<div>ok</div>');
  });
});

describe('SHELL_STYLE', () => {
  it('contains the brand color tokens', () => {
    expect(SHELL_STYLE).toContain('#0a090c');
    expect(SHELL_STYLE).toContain('#f7931a');
    expect(SHELL_STYLE).toContain('#f5f5f4');
  });

  it('ellipsizes only roster-row addresses', () => {
    const row = /\.row \.addr\{([^}]+)\}/.exec(SHELL_STYLE)?.[1] ?? '';
    expect(row).toContain('text-overflow:ellipsis');
    const withoutRow = SHELL_STYLE.replace(/\.row \.addr\{[^}]+\}/, '');
    expect(withoutRow).not.toMatch(/\.addr\{[^}]*text-overflow:ellipsis/);
  });
});
