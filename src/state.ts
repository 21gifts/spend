import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Unreadable or truncated day JSONL. */
export class CorruptStateError extends Error {
  constructor() {
    super('corrupt payout state');
    this.name = 'CorruptStateError';
  }
}

/** One JSONL row for a UTC day. */
export interface StateRow {
  ts: string;
  address: string;
  invoiceId: string;
  paymentHash: string;
  status: 'dry-run' | 'paid' | 'failed' | 'uncertain';
}

/**
 * File-backed per-day payout log.
 *
 * `bucket` `'daily'` (default) uses `${day}.jsonl` / `${day}.finished`.
 * `'moderator'` uses `${day}.moderator.jsonl` / `${day}.moderator.finished`.
 */
export class DayState {
  constructor(
    private readonly dir: string,
    private readonly day: string,
    private readonly io: {
      exists: (path: string) => boolean;
      read: (path: string) => string;
      append: (path: string, data: string) => void;
      mkdir: (path: string) => void;
    } = {
      exists: existsSync,
      read: (path) => readFileSync(path, 'utf8'),
      append: (path, data) => {
        const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY);
        try {
          writeSync(fd, data);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      },
      mkdir: (path) => mkdirSync(path, { recursive: true }),
    },
    private readonly bucket: 'daily' | 'moderator' = 'daily',
  ) {}

  /**
   * Load rows for this UTC day.
   *
   * @returns Existing rows (empty when the file is missing).
   */
  load(): StateRow[] {
    const path = this.path();
    if (!this.io.exists(path)) {
      return [];
    }
    let raw: string;
    try {
      raw = this.io.read(path);
    } catch {
      throw new CorruptStateError();
    }
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    const rows: StateRow[] = [];
    for (const line of lines) {
      rows.push(parseStateRow(line));
    }
    return rows;
  }

  /**
   * Append one row.
   *
   * @param row - Event to persist.
   */
  append(row: StateRow): void {
    const path = this.path();
    this.io.mkdir(dirname(path));
    this.io.append(path, `${JSON.stringify(row)}\n`);
  }

  /**
   * Persist that midnight must not re-enter this UTC day (every recipient is
   * blocked, or the run halted). Survives process restart — unlike in-memory
   * `lastDay`. Catch-up still pays newly added recipients.
   */
  markFinished(): void {
    const path = this.finishedPath();
    if (this.io.exists(path)) {
      return;
    }
    this.io.mkdir(dirname(path));
    this.io.append(path, `${this.day}\n`);
  }

  /**
   * @returns Whether {@link markFinished} has run for this day.
   */
  isFinished(): boolean {
    return this.io.exists(this.finishedPath());
  }

  private path(): string {
    if (this.bucket === 'moderator') {
      return join(this.dir, `${this.day}.moderator.jsonl`);
    }
    return join(this.dir, `${this.day}.jsonl`);
  }

  private finishedPath(): string {
    if (this.bucket === 'moderator') {
      return join(this.dir, `${this.day}.moderator.finished`);
    }
    return join(this.dir, `${this.day}.finished`);
  }
}

const STATUSES = new Set<StateRow['status']>(['dry-run', 'paid', 'failed', 'uncertain']);

function parseStateRow(line: string): StateRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CorruptStateError();
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new CorruptStateError();
  }
  const rec = parsed as Record<string, unknown>;
  const ts = rec['ts'];
  const address = rec['address'];
  const invoiceId = rec['invoiceId'];
  const paymentHash = rec['paymentHash'];
  const status = rec['status'];
  if (
    typeof ts !== 'string' ||
    typeof address !== 'string' ||
    typeof invoiceId !== 'string' ||
    typeof paymentHash !== 'string' ||
    typeof status !== 'string' ||
    !STATUSES.has(status as StateRow['status'])
  ) {
    throw new CorruptStateError();
  }
  return { ts, address, invoiceId, paymentHash, status: status as StateRow['status'] };
}

/**
 * Latest status for an address on this day, if any.
 *
 * @param rows - Loaded log.
 * @param address - Recipient.
 * @returns Last matching status.
 */
export function latestStatus(rows: StateRow[], address: string): StateRow['status'] | undefined {
  let found: StateRow['status'] | undefined;
  for (const row of rows) {
    if (row.address.toLowerCase() === address.toLowerCase()) {
      found = row.status;
    }
  }
  return found;
}

/**
 * Last `paid` or `uncertain` status for an address, ignoring later `dry-run` rows.
 *
 * @param rows - Loaded log.
 * @param address - Recipient or halt sentinel.
 * @returns Blocking status, if any.
 */
export function dayBlock(rows: StateRow[], address: string): 'paid' | 'uncertain' | undefined {
  let found: 'paid' | 'uncertain' | undefined;
  for (const row of rows) {
    if (row.address.toLowerCase() === address.toLowerCase() && (row.status === 'paid' || row.status === 'uncertain')) {
      found = row.status;
    }
  }
  return found;
}
