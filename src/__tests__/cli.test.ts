import { describe, it, expect } from 'vitest';
import { isUtcMidnightWindow, main, parseArgs } from '../cli';

describe('parseArgs', () => {
  it('defaults to dry-run and today', () => {
    const flags = parseArgs(['bun', 'cli']);
    expect(flags.ok).toBe(true);
    if (flags.ok) {
      expect(flags.live).toBe(false);
      expect(flags.atUtcMidnight).toBe(false);
      expect(flags.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('reads --live, --date, and --at-utc-midnight', () => {
    expect(
      parseArgs(
        ['bun', 'cli', '--live', '--at-utc-midnight', '--date', '2026-08-23'],
        new Date('2026-08-25T00:00:00.000Z'),
      ),
    ).toEqual({
      ok: true,
      live: true,
      day: '2026-08-23',
      atUtcMidnight: true,
    });
  });

  it('defaults the day from the injected clock', () => {
    expect(parseArgs(['bun', 'cli'], new Date('2026-08-25T00:00:00.000Z'))).toEqual({
      ok: true,
      live: false,
      day: '2026-08-25',
      atUtcMidnight: false,
    });
  });

  it('rejects a missing or malformed --date', () => {
    expect(parseArgs(['bun', 'cli', '--date']).ok).toBe(false);
    expect(parseArgs(['bun', 'cli', '--date', '2026-8-23']).ok).toBe(false);
  });
});

describe('isUtcMidnightWindow', () => {
  it('accepts the first minutes of UTC hour 0', () => {
    expect(isUtcMidnightWindow(new Date('2026-08-25T00:00:00.000Z'))).toBe(true);
    expect(isUtcMidnightWindow(new Date('2026-08-25T00:05:00.000Z'))).toBe(true);
  });

  it('rejects later UTC hours and minutes after 05', () => {
    expect(isUtcMidnightWindow(new Date('2026-08-25T00:06:00.000Z'))).toBe(false);
    expect(isUtcMidnightWindow(new Date('2026-08-24T22:00:00.000Z'))).toBe(false);
    expect(isUtcMidnightWindow(new Date('2026-08-25T02:00:00.000Z'))).toBe(false);
  });
});

describe('main --at-utc-midnight', () => {
  it('exits 0 outside the window without loading config', async () => {
    const code = await main({}, ['bun', 'cli', '--live', '--at-utc-midnight'], () =>
      new Date('2026-08-24T22:00:00.000Z'),
    );
    expect(code).toBe(0);
  });

  it('still loads config when --at-utc-midnight is omitted', async () => {
    const code = await main({}, ['bun', 'cli', '--live'], () =>
      new Date('2026-08-24T22:00:00.000Z'),
    );
    expect(code).toBe(2);
  });

  it('loads config after the window opens', async () => {
    const code = await main({}, ['bun', 'cli', '--live', '--at-utc-midnight'], () =>
      new Date('2026-08-25T00:00:00.000Z'),
    );
    expect(code).toBe(2);
  });
});
