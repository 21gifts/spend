import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDraining, setDraining } from '../drain';

describe('drain flag', () => {
  it('is off when missing, on after entering, and off after leaving', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-drain-flag-'));
    try {
      const stateDir = join(dir, 'state');
      expect(isDraining(stateDir)).toBe(false);
      setDraining(stateDir, true, new Date('2026-08-25T12:00:00.000Z'));
      expect(isDraining(stateDir)).toBe(true);
      setDraining(stateDir, false, new Date('2026-08-25T12:00:00.000Z'));
      expect(isDraining(stateDir)).toBe(false);
      setDraining(stateDir, false, new Date('2026-08-25T12:00:00.000Z'));
      expect(isDraining(stateDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts an unreadable flag as draining', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-drain-flag-'));
    try {
      const notADir = join(dir, 'file');
      writeFileSync(notADir, '');
      expect(isDraining(notADir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
