import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Path of the drain flag. Its presence means new pings are refused; it
 * survives a restart until an operator leaves drain mode.
 *
 * @param stateDir - `STATE_DIR`.
 * @returns `${stateDir}/draining`.
 */
function drainFlagPath(stateDir: string): string {
  return join(stateDir, 'draining');
}

/**
 * Whether drain mode is on.
 *
 * @param stateDir - `STATE_DIR`.
 * @returns True when the drain flag exists.
 */
export function isDraining(stateDir: string): boolean {
  return existsSync(drainFlagPath(stateDir));
}

/**
 * Enter or leave drain mode. Entering writes and fsyncs the flag; leaving removes it.
 *
 * @param stateDir - `STATE_DIR`.
 * @param enabled - True to enter drain mode, false to leave it.
 * @param now - Timestamp written into the flag.
 */
export function setDraining(stateDir: string, enabled: boolean, now: Date): void {
  const path = drainFlagPath(stateDir);
  if (!enabled) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(stateDir, { recursive: true });
  const fd = openSync(path, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY);
  try {
    writeSync(fd, `${now.toISOString()}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
