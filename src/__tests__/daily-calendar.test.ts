import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DailyCalendar } from '../daily-calendar';
import { fileDayLock } from '../lock';
import type { StateRow } from '../state';

const dirs: string[] = [];
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daily-calendar-'));
  dirs.push(dir);
  return dir;
}
function attempt(ts: string, address = 'alice@example.com'): StateRow {
  return { ts, address, invoiceId: 'invoice', paymentHash: 'a'.repeat(64), status: 'uncertain' };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('DailyCalendar', () => {
  it('blocks a second Honolulu Monday payment after UTC midnight and a restart', () => {
    const dir = directory();
    expect(new DailyCalendar(dir).reserve(attempt('2026-10-05T23:59:59.000Z'), 'Pacific/Honolulu')).toBe('reserved');
    const restarted = new DailyCalendar(dir);
    expect(restarted.blocked('ALICE@example.com', new Date('2026-10-06T00:00:00.000Z'), 'Pacific/Honolulu')).toBe(true);
    expect(restarted.reserve(attempt('2026-10-06T01:00:00.000Z'), 'Pacific/Honolulu')).toBe('local_monday_claimed');
    expect(restarted.blocked('bob@example.com', new Date('2026-10-06T01:00:00.000Z'), 'Pacific/Honolulu')).toBe(false);
    expect(restarted.blocked('alice@example.com', new Date('2026-10-06T10:00:00.000Z'), 'Pacific/Honolulu')).toBe(false);
    expect(restarted.blocked('alice@example.com', new Date('2026-10-12T23:00:00.000Z'), 'Pacific/Honolulu')).toBe(false);
  });

  it('blocks a second Kiritimati Monday across the Sunday/Monday UTC boundary', () => {
    const calendar = new DailyCalendar(directory());
    expect(calendar.reserve(attempt('2026-10-04T19:00:00.000Z'), 'Pacific/Kiritimati')).toBe('reserved');
    expect(calendar.blocked('alice@example.com', new Date('2026-10-05T01:00:00.000Z'), 'Pacific/Kiritimati')).toBe(true);
  });

  it('uses Manila for a legacy caller and does not consume an allowance by checking', () => {
    const calendar = new DailyCalendar(directory());
    const instant = new Date('2026-10-05T02:00:00.000Z');
    expect(calendar.blocked('alice@example.com', instant)).toBe(false);
    expect(calendar.blocked('alice@example.com', instant)).toBe(false);
    expect(calendar.reserve(attempt(instant.toISOString()))).toBe('reserved');
    expect(calendar.blocked('alice@example.com', instant)).toBe(true);
  });

  it('records every attempt, so changing the zone cannot hide a payment within that Monday', () => {
    const calendar = new DailyCalendar(directory());
    // It is Tuesday in Manila but still Monday in Honolulu.
    expect(calendar.reserve(attempt('2026-10-06T00:30:00.000Z'), 'Asia/Manila')).toBe('reserved');
    expect(calendar.blocked('alice@example.com', new Date('2026-10-06T01:00:00.000Z'), 'Pacific/Honolulu')).toBe(true);
  });

  it('recognizes pre-deployment payments in the previous UTC log, but not dry runs', () => {
    const dir = directory();
    const old = attempt('2026-10-05T23:00:00Z');
    writeFileSync(join(dir, '2026-10-05.jsonl'), JSON.stringify({ ...old, status: 'dry-run' }));
    const calendar = new DailyCalendar(dir);
    expect(calendar.blocked(old.address, new Date('2026-10-06T01:00:00Z'), 'Pacific/Honolulu')).toBe(false);
    writeFileSync(join(dir, '2026-10-05.jsonl'), JSON.stringify({ ...old, status: 'paid' }));
    expect(calendar.blocked(old.address, new Date('2026-10-06T01:00:00Z'), 'Pacific/Honolulu')).toBe(true);
  });

  it('refuses while the cross-day lock is held', () => {
    const dir = directory();
    const lock = fileDayLock(dir, 'daily-calendar');
    expect(lock.tryAcquire()).toBe(true);
    try {
      expect(new DailyCalendar(dir).reserve(attempt('2026-10-05T01:00:00.000Z'))).toBe('locked');
    } finally { lock.release(); }
    expect(new DailyCalendar(dir).reserve(attempt('2026-10-05T01:00:00.000Z'))).toBe('reserved');
  });

  it.each(['broken json', JSON.stringify(attempt('invalid date'))])('fails closed on unreadable history', (body) => {
    const dir = directory();
    writeFileSync(join(dir, 'daily-calendar.jsonl'), body);
    expect(() => new DailyCalendar(dir).reserve(attempt('2026-10-05T01:00:00.000Z'))).toThrow();
    // A failure still releases the shared lock.
    const lock = fileDayLock(dir, 'daily-calendar');
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });
});
