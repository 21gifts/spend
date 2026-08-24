import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileDayLock } from '../lock';

describe('fileDayLock', () => {
  it('acquires exclusively and allows acquire after release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      const first = fileDayLock(dir, '2026-08-23');
      const second = fileDayLock(dir, '2026-08-23');
      expect(first.tryAcquire()).toBe(true);
      expect(second.tryAcquire()).toBe(false);
      first.release();
      expect(second.tryAcquire()).toBe(true);
      second.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not unlink a held lock on release without acquire', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      const owner = fileDayLock(dir, '2026-08-23');
      const other = fileDayLock(dir, '2026-08-23');
      expect(owner.tryAcquire()).toBe(true);
      other.release();
      expect(fileDayLock(dir, '2026-08-23').tryAcquire()).toBe(false);
      owner.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
