import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileDayLock, LOCK_STALE_MS } from '../lock';

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

  it('steals a lock file older than LOCK_STALE_MS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      const path = join(dir, '2026-08-23.lock');
      writeFileSync(path, 'old');
      const stale = Date.now() - LOCK_STALE_MS - 1000;
      utimesSync(path, stale / 1000, stale / 1000);
      const lock = fileDayLock(dir, '2026-08-23');
      expect(lock.tryAcquire()).toBe(true);
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not steal a freshly written lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      const first = fileDayLock(dir, '2026-08-23');
      const second = fileDayLock(dir, '2026-08-23');
      expect(first.tryAcquire()).toBe(true);
      expect(second.tryAcquire()).toBe(false);
      first.release();

      const path = join(dir, '2026-08-24.lock');
      writeFileSync(path, 'fresh');
      const now = Date.now();
      utimesSync(path, now / 1000, now / 1000);
      expect(fileDayLock(dir, '2026-08-24').tryAcquire()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not steal a live owner even when mtime is stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      const owner = fileDayLock(dir, '2026-08-23');
      expect(owner.tryAcquire()).toBe(true);
      const path = join(dir, '2026-08-23.lock');
      const stale = Date.now() - LOCK_STALE_MS - 1000;
      utimesSync(path, stale / 1000, stale / 1000);
      expect(fileDayLock(dir, '2026-08-23').tryAcquire()).toBe(false);
      owner.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces a taking directory left by a previous incarnation of this pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      writeFileSync(join(dir, '2026-08-23.lock'), `${Date.now()}\n999999999\n`);
      mkdirSync(join(dir, '2026-08-23.taking'));
      writeFileSync(join(dir, '2026-08-23.taking', 'owner'), `${process.pid}\n`);
      expect(fileDayLock(dir, '2026-08-23').tryAcquire()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not replace a taking directory owned by a different live pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      writeFileSync(join(dir, '2026-08-23.lock'), `${Date.now()}\n999999999\n`);
      mkdirSync(join(dir, '2026-08-23.taking'));
      writeFileSync(join(dir, '2026-08-23.taking', 'owner'), '1\n');
      expect(fileDayLock(dir, '2026-08-23').tryAcquire()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('steals a leftover lock that reused this pid from a previous incarnation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      const path = join(dir, '2026-08-23.lock');
      const started = Date.now() - process.uptime() * 1000;
      writeFileSync(path, `${started - 10_000}\n${process.pid}\n`);
      const lock = fileDayLock(dir, '2026-08-23');
      expect(lock.tryAcquire()).toBe(true);
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('steals a lock whose owner pid is dead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      const path = join(dir, '2026-08-23.lock');
      writeFileSync(path, `${Date.now()}\n999999999\n`);
      const lock = fileDayLock(dir, '2026-08-23');
      expect(lock.tryAcquire()).toBe(true);
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('release does not unlink a lock file that holds another token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-lock-'));
    try {
      const owner = fileDayLock(dir, '2026-08-23');
      expect(owner.tryAcquire()).toBe(true);
      const path = join(dir, '2026-08-23.lock');
      writeFileSync(path, `${Date.now()}\n${process.pid}\n`);
      owner.release();
      expect(fileDayLock(dir, '2026-08-23').tryAcquire()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
