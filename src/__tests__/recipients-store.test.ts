import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CorruptRecipientsError,
  LIVE_RECIPIENTS_FILE,
  ensureLiveRecipients,
  loadLiveRecipients,
  parseRecipientsJson,
  saveLiveRecipients,
} from '../recipients-store';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spend-recip-'));
  dirs.push(dir);
  return dir;
}

describe('parseRecipientsJson', () => {
  it('accepts an empty list and a default comment', () => {
    expect(parseRecipientsJson('{"recipients":[]}')).toEqual({
      comment: '21gifts daily',
      recipients: [],
      moderators: [],
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
  });

  it('treats a missing moderators key as an empty list', () => {
    expect(
      parseRecipientsJson(
        JSON.stringify({
          comment: 'daily',
          recipients: [{ address: 'a@b.com', amountUsd: 1 }],
        }),
      ),
    ).toEqual({
      comment: 'daily',
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
      moderators: [],
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
  });

  it('trims addresses and keeps comments', () => {
    const parsed = parseRecipientsJson(
      JSON.stringify({
        comment: 'daily',
        recipients: [{ address: ' a@b.com ', amountUsd: 1.5, comment: 'note' }],
        moderators: [{ address: ' m@x.com ', amountUsd: 5, comment: 'mod' }],
      }),
    );
    expect(parsed).toEqual({
      comment: 'daily',
      recipients: [{ address: 'a@b.com', amountUsd: 1.5, comment: 'note' }],
      moderators: [{ address: 'm@x.com', amountUsd: 5, comment: 'mod' }],
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
  });

  it('allows the same address on both lists', () => {
    expect(
      parseRecipientsJson(
        JSON.stringify({
          recipients: [{ address: 'a@b.com', amountUsd: 1 }],
          moderators: [{ address: 'a@b.com', amountUsd: 5 }],
        }),
      ),
    ).toEqual({
      comment: '21gifts daily',
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
      moderators: [{ address: 'a@b.com', amountUsd: 5 }],
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
  });

  it('rejects invalid JSON, non-arrays, duplicates, and bad fields', () => {
    expect(() => parseRecipientsJson('{')).toThrow(CorruptRecipientsError);
    expect(() => parseRecipientsJson('null')).toThrow(CorruptRecipientsError);
    expect(() => parseRecipientsJson('[]')).toThrow(CorruptRecipientsError);
    expect(() => parseRecipientsJson('1')).toThrow(CorruptRecipientsError);
    expect(() => parseRecipientsJson('{}')).toThrow(/array/);
    expect(() => parseRecipientsJson('{"recipients":[null]}')).toThrow(/object/);
    expect(() => parseRecipientsJson('{"recipients":[{"address":1,"amountUsd":1}]}')).toThrow(
      /Lightning Address/,
    );
    expect(() => parseRecipientsJson('{"recipients":[{"address":"nope","amountUsd":1}]}')).toThrow(
      /Lightning Address/,
    );
    expect(() => parseRecipientsJson('{"recipients":[{"address":"a@b.com","amountUsd":0}]}')).toThrow(
      /amountUsd/,
    );
    expect(() =>
      parseRecipientsJson(
        JSON.stringify({
          recipients: [
            { address: 'a@b.com', amountUsd: 1 },
            { address: 'a@b.com', amountUsd: 2 },
          ],
        }),
      ),
    ).toThrow(/duplicate/);
  });

  it('rejects each corrupt moderators case', () => {
    const daily = { recipients: [{ address: 'a@b.com', amountUsd: 1 }] };
    expect(() => parseRecipientsJson(JSON.stringify({ ...daily, moderators: {} }))).toThrow(
      /moderators must be an array/,
    );
    expect(() => parseRecipientsJson(JSON.stringify({ ...daily, moderators: null }))).toThrow(
      /moderators must be an array/,
    );
    expect(() => parseRecipientsJson(JSON.stringify({ ...daily, moderators: [null] }))).toThrow(
      /each moderator must be an object/,
    );
    expect(() =>
      parseRecipientsJson(JSON.stringify({ ...daily, moderators: [{ address: 1, amountUsd: 1 }] })),
    ).toThrow(/each moderator needs a Lightning Address/);
    expect(() =>
      parseRecipientsJson(
        JSON.stringify({ ...daily, moderators: [{ address: 'nope', amountUsd: 1 }] }),
      ),
    ).toThrow(/each moderator needs a Lightning Address/);
    expect(() =>
      parseRecipientsJson(
        JSON.stringify({ ...daily, moderators: [{ address: 'm@x.com', amountUsd: 0 }] }),
      ),
    ).toThrow(/each moderator needs amountUsd > 0/);
    expect(() =>
      parseRecipientsJson(
        JSON.stringify({
          ...daily,
          moderators: [
            { address: 'm@x.com', amountUsd: 1 },
            { address: 'm@x.com', amountUsd: 2 },
          ],
        }),
      ),
    ).toThrow(/duplicate moderator address m@x.com/);
  });

  it('treats missing payment switches as enabled', () => {
    expect(
      parseRecipientsJson(
        JSON.stringify({
          comment: 'daily',
          recipients: [{ address: 'a@b.com', amountUsd: 1 }],
        }),
      ),
    ).toEqual({
      comment: 'daily',
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
      moderators: [],
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
  });

  it('reads explicit true and false payment switches', () => {
    expect(
      parseRecipientsJson(
        JSON.stringify({
          recipients: [],
          paymentsEnabled: true,
          moderatorPaymentsEnabled: true,
        }),
      ),
    ).toEqual({
      comment: '21gifts daily',
      recipients: [],
      moderators: [],
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(
      parseRecipientsJson(
        JSON.stringify({
          recipients: [],
          paymentsEnabled: false,
          moderatorPaymentsEnabled: false,
        }),
      ),
    ).toEqual({
      comment: '21gifts daily',
      recipients: [],
      moderators: [],
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
    });
    expect(
      parseRecipientsJson(
        JSON.stringify({
          recipients: [],
          paymentsEnabled: false,
          moderatorPaymentsEnabled: true,
        }),
      ),
    ).toMatchObject({ paymentsEnabled: false, moderatorPaymentsEnabled: true });
    expect(
      parseRecipientsJson(
        JSON.stringify({
          recipients: [],
          paymentsEnabled: true,
          moderatorPaymentsEnabled: false,
        }),
      ),
    ).toMatchObject({ paymentsEnabled: true, moderatorPaymentsEnabled: false });
  });

  it('rejects a non-boolean paymentsEnabled', () => {
    const daily = { recipients: [] as Array<{ address: string; amountUsd: number }> };
    expect(() => parseRecipientsJson(JSON.stringify({ ...daily, paymentsEnabled: 'true' }))).toThrow(
      /^paymentsEnabled must be a boolean$/,
    );
    expect(() => parseRecipientsJson(JSON.stringify({ ...daily, paymentsEnabled: 1 }))).toThrow(
      /^paymentsEnabled must be a boolean$/,
    );
    expect(() => parseRecipientsJson(JSON.stringify({ ...daily, paymentsEnabled: null }))).toThrow(
      /^paymentsEnabled must be a boolean$/,
    );
    expect(() => parseRecipientsJson(JSON.stringify({ ...daily, paymentsEnabled: {} }))).toThrow(
      /^paymentsEnabled must be a boolean$/,
    );
    expect(() => parseRecipientsJson(JSON.stringify({ ...daily, paymentsEnabled: [] }))).toThrow(
      /^paymentsEnabled must be a boolean$/,
    );
  });

  it('rejects a non-boolean moderatorPaymentsEnabled', () => {
    const daily = { recipients: [] as Array<{ address: string; amountUsd: number }> };
    expect(() =>
      parseRecipientsJson(JSON.stringify({ ...daily, moderatorPaymentsEnabled: 'false' })),
    ).toThrow(/^moderatorPaymentsEnabled must be a boolean$/);
    expect(() =>
      parseRecipientsJson(JSON.stringify({ ...daily, moderatorPaymentsEnabled: 0 })),
    ).toThrow(/^moderatorPaymentsEnabled must be a boolean$/);
    expect(() =>
      parseRecipientsJson(JSON.stringify({ ...daily, moderatorPaymentsEnabled: null })),
    ).toThrow(/^moderatorPaymentsEnabled must be a boolean$/);
    expect(() =>
      parseRecipientsJson(JSON.stringify({ ...daily, moderatorPaymentsEnabled: {} })),
    ).toThrow(/^moderatorPaymentsEnabled must be a boolean$/);
    expect(() =>
      parseRecipientsJson(JSON.stringify({ ...daily, moderatorPaymentsEnabled: [] })),
    ).toThrow(/^moderatorPaymentsEnabled must be a boolean$/);
  });
});

describe('ensureLiveRecipients', () => {
  it('copies the seed when the live file is missing and never overwrites', () => {
    const dir = tmp();
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"seed","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    ensureLiveRecipients(dir, seed);
    expect(JSON.parse(readFileSync(join(dir, LIVE_RECIPIENTS_FILE), 'utf8')).comment).toBe('seed');
    writeFileSync(seed, '{"comment":"new-seed","recipients":[{"address":"z@z.com","amountUsd":9}]}\n');
    ensureLiveRecipients(dir, seed);
    expect(JSON.parse(readFileSync(join(dir, LIVE_RECIPIENTS_FILE), 'utf8')).comment).toBe('seed');
  });

  it('throws when the seed cannot be read', () => {
    expect(() => ensureLiveRecipients(tmp(), join(tmp(), 'missing.json'))).toThrow(
      CorruptRecipientsError,
    );
  });
});

describe('load and save', () => {
  it('round-trips an empty live list', () => {
    const dir = tmp();
    saveLiveRecipients(dir, {
      comment: 'x',
      recipients: [],
      moderators: [],
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
    expect(loadLiveRecipients(dir)).toEqual({
      comment: 'x',
      recipients: [],
      moderators: [],
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
    });
  });

  it('round-trips recipients and moderators', () => {
    const dir = tmp();
    const data = {
      comment: 'daily',
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
      moderators: [{ address: 'm@x.com', amountUsd: 7.5 }],
      paymentsEnabled: false,
      moderatorPaymentsEnabled: true,
    };
    saveLiveRecipients(dir, data);
    const raw = JSON.parse(readFileSync(join(dir, LIVE_RECIPIENTS_FILE), 'utf8')) as {
      moderators: unknown;
      paymentsEnabled: unknown;
      moderatorPaymentsEnabled: unknown;
    };
    expect(raw.moderators).toEqual([{ address: 'm@x.com', amountUsd: 7.5 }]);
    expect(raw.paymentsEnabled).toBe(false);
    expect(raw.moderatorPaymentsEnabled).toBe(true);
    expect(loadLiveRecipients(dir)).toEqual(data);
  });

  it('throws when the live file is missing or corrupt', () => {
    expect(() => loadLiveRecipients(tmp())).toThrow(CorruptRecipientsError);
    const dir = tmp();
    writeFileSync(join(dir, LIVE_RECIPIENTS_FILE), '{');
    expect(() => loadLiveRecipients(dir)).toThrow(CorruptRecipientsError);
  });
});
