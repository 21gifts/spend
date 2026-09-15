import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** Exclusive process mutex for one UTC payout day's run (live or dry-run). */
export interface DayLock {
  tryAcquire(): boolean;
  release(): void;
}

/**
 * Fallback age when the lock file has no readable owner pid.
 * A different live owner pid is never stolen via this mtime path.
 */
export const LOCK_STALE_MS = 10 * 60 * 1000;

function createTakingFile(taking: string): boolean {
  try {
    const fd = openSync(taking, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    try {
      writeSync(fd, `${process.pid}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function withStealMutex(dir: string, day: string, fn: () => boolean): boolean {
  const taking = join(dir, `${day}.taking`);
  if (!createTakingFile(taking)) {
    return false;
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(taking);
    } catch {
      // already gone
    }
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    // EPERM: process exists but we cannot signal it — still alive.
    return code === 'EPERM';
  }
}

function ownerPid(raw: string): number | null {
  const pidLine = raw.split('\n')[1];
  if (pidLine === undefined || pidLine === '') {
    return null;
  }
  const pid = Number(pidLine);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

function lockWrittenAt(raw: string): number | null {
  const line = raw.split('\n')[0];
  if (line === undefined || line === '') {
    return null;
  }
  const ts = Number(line);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function contentsStealable(raw: string, path: string, now: () => number): boolean {
  const pid = ownerPid(raw);
  if (pid !== null) {
    if (pid === process.pid) {
      const written = lockWrittenAt(raw);
      const started = now() - process.uptime() * 1000;
      return written !== null && written < started;
    }
    return !pidAlive(pid);
  }
  try {
    return now() - statSync(path).mtimeMs >= LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Create a lock file with `O_EXCL` under `dir/{day}.lock`.
 *
 * Steal when the owner pid is dead, or when the pid is this process but the
 * lock was written before this incarnation started (PID reuse after restart).
 * Never unlink a file whose pid is a different live process. Steal of a leftover
 * is serialized with a virgin `O_EXCL` `{day}.taking` file — an existing taking
 * file is never replaced (fail-closed). `release` unlinks only if the path still
 * holds this process's token.
 *
 * @param dir - State directory.
 * @param day - UTC date `YYYY-MM-DD`.
 * @param now - Clock (tests).
 * @returns Lock handle.
 */
export function fileDayLock(dir: string, day: string, now: () => number = Date.now): DayLock {
  const path = join(dir, `${day}.lock`);
  let fd: number | undefined;
  let token: string | undefined;

  const tryCreate = (): 'ok' | 'excl' | 'mismatch' => {
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch {
      return 'excl';
    }
    const next = `${now()}\n${process.pid}\n`;
    try {
      writeSync(fd, next);
      fsyncSync(fd);
      if (readFileSync(path, 'utf8') !== next) {
        throw new Error('lock token mismatch');
      }
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
      fd = undefined;
      try {
        const onDisk = readFileSync(path, 'utf8');
        if (onDisk === next || onDisk === '') {
          unlinkSync(path);
        }
      } catch {
        try {
          unlinkSync(path);
        } catch {
          // gone
        }
      }
      return 'mismatch';
    }
    token = next;
    return 'ok';
  };

  return {
    tryAcquire(): boolean {
      mkdirSync(dir, { recursive: true });
      const first = tryCreate();
      if (first === 'ok') {
        return true;
      }
      if (first === 'mismatch') {
        return false;
      }
      return withStealMutex(dir, day, () => {
        let raw: string;
        try {
          raw = readFileSync(path, 'utf8');
        } catch {
          return tryCreate() === 'ok';
        }
        if (!contentsStealable(raw, path, now)) {
          return false;
        }
        try {
          if (readFileSync(path, 'utf8') !== raw) {
            return false;
          }
          if (!contentsStealable(raw, path, now)) {
            return false;
          }
          unlinkSync(path);
        } catch {
          // leftover may already be gone
        }
        return tryCreate() === 'ok';
      });
    },
    release(): void {
      if (fd === undefined) {
        return;
      }
      closeSync(fd);
      fd = undefined;
      const owned = token;
      token = undefined;
      if (owned === undefined) {
        return;
      }
      try {
        if (readFileSync(path, 'utf8') !== owned) {
          return;
        }
        unlinkSync(path);
      } catch {
        // Lock file may already be gone or replaced.
      }
    },
  };
}
