import { describe, it, expect } from 'vitest';
import { CorruptStateError, DayState, dayBlock, latestStatus } from '../state';

describe('DayState', () => {
  it('returns no rows when the file is missing', () => {
    const state = new DayState('/tmp', '2026-08-23', {
      exists: () => false,
      read: () => '',
      append: () => undefined,
      mkdir: () => undefined,
    });
    expect(state.load()).toEqual([]);
  });

  it('throws CorruptStateError on an unreadable JSONL line', () => {
    const state = new DayState('/tmp', '2026-08-23', {
      exists: () => true,
      read: () =>
        `${JSON.stringify({ ts: 't', address: 'a@b.com', invoiceId: '1', paymentHash: 'h', status: 'paid' })}\nnot-json\n`,
      append: () => undefined,
      mkdir: () => undefined,
    });
    expect(() => state.load()).toThrow(CorruptStateError);
  });

  it('throws CorruptStateError on a JSON object with an invalid status', () => {
    const state = new DayState('/tmp', '2026-08-23', {
      exists: () => true,
      read: () =>
        `${JSON.stringify({ ts: 't', address: 'a@b.com', invoiceId: '1', paymentHash: 'h', status: 'paif' })}\n`,
      append: () => undefined,
      mkdir: () => undefined,
    });
    expect(() => state.load()).toThrow(CorruptStateError);
  });

  it('appends a row after mkdir', () => {
    const writes: string[] = [];
    const state = new DayState('/tmp', '2026-08-23', {
      exists: () => false,
      read: () => '',
      append: (_path, data) => {
        writes.push(data);
      },
      mkdir: () => undefined,
    });
    state.append({
      ts: 't',
      address: 'a@b.com',
      invoiceId: '1',
      paymentHash: 'h',
      status: 'dry-run',
    });
    expect(writes[0]).toContain('dry-run');
  });

  it('moderator bucket appends to a .moderator.jsonl path', () => {
    let appendPath = '';
    const state = new DayState(
      '/tmp',
      '2026-08-23',
      {
        exists: () => false,
        read: () => '',
        append: (path) => {
          appendPath = path;
        },
        mkdir: () => undefined,
      },
      'moderator',
    );
    state.append({
      ts: 't',
      address: 'a@b.com',
      invoiceId: '1',
      paymentHash: 'h',
      status: 'paid',
    });
    expect(appendPath.endsWith('.moderator.jsonl')).toBe(true);
  });

  it('welcome bucket appends to a welcome.jsonl path', () => {
    let appendPath = '';
    const state = new DayState(
      '/tmp',
      '2026-08-23',
      {
        exists: () => false,
        read: () => '',
        append: (path) => {
          appendPath = path;
        },
        mkdir: () => undefined,
      },
      'welcome',
    );
    state.append({
      ts: 't',
      address: 'a@b.com',
      invoiceId: '1',
      paymentHash: 'h',
      status: 'paid',
    });
    expect(appendPath.endsWith('welcome.jsonl')).toBe(true);
  });

  it('markFinished appends once and isFinished becomes true', () => {
    const writes: string[] = [];
    const files = new Set<string>();
    const state = new DayState('/tmp', '2026-08-23', {
      exists: (path) => files.has(path),
      read: () => '',
      append: (path, data) => {
        files.add(path);
        writes.push(data);
      },
      mkdir: () => undefined,
    });
    expect(state.isFinished()).toBe(false);
    state.markFinished();
    expect(state.isFinished()).toBe(true);
    expect(writes).toEqual(['2026-08-23\n']);
    state.markFinished();
    expect(writes).toEqual(['2026-08-23\n']);
  });
});

describe('latestStatus', () => {
  it('returns the last status for an address', () => {
    expect(
      latestStatus(
        [
          {
            ts: '1',
            address: 'a@b.com',
            invoiceId: '1',
            paymentHash: 'h',
            status: 'dry-run',
          },
          {
            ts: '2',
            address: 'a@b.com',
            invoiceId: '1',
            paymentHash: 'h',
            status: 'paid',
          },
        ],
        'a@b.com',
      ),
    ).toBe('paid');
  });

  it('matches an address case-insensitively', () => {
    expect(
      latestStatus(
        [
          {
            ts: '1',
            address: 'a@b.com',
            invoiceId: '1',
            paymentHash: 'h',
            status: 'paid',
          },
        ],
        'A@b.com',
      ),
    ).toBe('paid');
  });
});

describe('dayBlock', () => {
  it('ignores a later dry-run after paid', () => {
    expect(
      dayBlock(
        [
          {
            ts: '1',
            address: 'a@b.com',
            invoiceId: '1',
            paymentHash: 'h',
            status: 'paid',
          },
          {
            ts: '2',
            address: 'a@b.com',
            invoiceId: '1',
            paymentHash: 'h',
            status: 'dry-run',
          },
        ],
        'a@b.com',
      ),
    ).toBe('paid');
  });

  it('matches an address case-insensitively', () => {
    expect(
      dayBlock(
        [
          {
            ts: '1',
            address: 'a@b.com',
            invoiceId: '1',
            paymentHash: 'h',
            status: 'uncertain',
          },
        ],
        'A@b.com',
      ),
    ).toBe('uncertain');
  });
});
