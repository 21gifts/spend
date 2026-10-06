import { fileDayLock, type DayLock } from './lock';
import { CorruptStateError, DayState, type StateRow } from './state';

/** Local date and weekday, using Manila for legacy callers without a zone. */
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * Durable daily-payment attempts across UTC day files. A reservation is fsynced
 * before paying; an uncertain payment also consumes its local Monday allowance.
 * The shared file lock makes checking and reserving atomic across processes.
 */
export class DailyCalendar {
  constructor(
    stateDir: string,
    private readonly state = new DayState(stateDir, 'daily-calendar'),
    private readonly lock: DayLock = fileDayLock(stateDir, 'daily-calendar'),
    private readonly legacyRows: (day: string) => StateRow[] =
      (day) => new DayState(stateDir, day).load(),
  ) {}

  /** Whether an earlier daily payment attempt falls on this local Monday. */
  blocked(address: string, instant: Date, timeZone = 'Asia/Manila'): boolean {
    const today = localDate(instant, timeZone);
    if (!today.includes('Mon')) return false;
    const rows = [
      ...this.state.load(),
      ...this.legacyRows(instant.toISOString().slice(0, 10)),
      ...this.legacyRows(new Date(instant.getTime() - 86_400_000).toISOString().slice(0, 10)),
    ];
    return rows.some((row) => {
      if (row.status !== 'paid' && row.status !== 'uncertain') return false;
      if (row.address.toLowerCase() !== address.toLowerCase()) return false;
      const date = new Date(row.ts);
      if (!Number.isFinite(date.getTime())) throw new CorruptStateError();
      return localDate(date, timeZone) === today;
    });
  }

  /** Reserve before external payment; failure never permits a payment. */
  reserve(row: StateRow, timeZone = 'Asia/Manila'): 'reserved' | 'local_monday_claimed' | 'locked' {
    if (!this.lock.tryAcquire()) return 'locked';
    try {
      if (this.blocked(row.address, new Date(row.ts), timeZone)) return 'local_monday_claimed';
      this.state.append(row);
      return 'reserved';
    } finally {
      this.lock.release();
    }
  }
}
