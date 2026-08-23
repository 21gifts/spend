import { closeSync, constants, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Exclusive process mutex for one UTC payout day's live run. */
export interface DayLock {
  tryAcquire(): boolean;
  release(): void;
}

/**
 * Create a lock file with `O_EXCL` under `dir/{day}.lock`.
 *
 * @param dir - State directory.
 * @param day - UTC date `YYYY-MM-DD`.
 * @returns Lock handle.
 */
export function fileDayLock(dir: string, day: string): DayLock {
  const path = join(dir, `${day}.lock`);
  let fd: number | undefined;
  return {
    tryAcquire(): boolean {
      mkdirSync(dir, { recursive: true });
      try {
        fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        return true;
      } catch {
        return false;
      }
    },
    release(): void {
      if (fd === undefined) {
        return;
      }
      closeSync(fd);
      fd = undefined;
      try {
        unlinkSync(path);
      } catch {
        // Lock file may already be gone.
      }
    },
  };
}
