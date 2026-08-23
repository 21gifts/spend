import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
      append: (path, data) => appendFileSync(path, data),
      mkdir: (path) => mkdirSync(path, { recursive: true }),
    },
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
    const lines = this.io.read(path).split('\n').filter((line) => line.trim() !== '');
    const rows: StateRow[] = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line) as StateRow);
      } catch {
        throw new CorruptStateError();
      }
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

  private path(): string {
    return join(this.dir, `${this.day}.jsonl`);
  }
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
    if (row.address === address) {
      found = row.status;
    }
  }
  return found;
}
