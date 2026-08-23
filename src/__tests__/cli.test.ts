import { describe, it, expect } from 'vitest';
import { parseArgs } from '../cli';

describe('parseArgs', () => {
  it('defaults to dry-run and today', () => {
    const flags = parseArgs(['bun', 'cli']);
    expect(flags.ok).toBe(true);
    if (flags.ok) {
      expect(flags.live).toBe(false);
      expect(flags.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('reads --live and --date', () => {
    expect(parseArgs(['bun', 'cli', '--live', '--date', '2026-08-23'])).toEqual({
      ok: true,
      live: true,
      day: '2026-08-23',
    });
  });

  it('rejects a missing or malformed --date', () => {
    expect(parseArgs(['bun', 'cli', '--date']).ok).toBe(false);
    expect(parseArgs(['bun', 'cli', '--date', '2026-8-23']).ok).toBe(false);
  });
});
