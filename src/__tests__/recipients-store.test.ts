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
    });
  });

  it('trims addresses and keeps comments', () => {
    const parsed = parseRecipientsJson(
      JSON.stringify({
        comment: 'daily',
        recipients: [{ address: ' a@b.com ', amountUsd: 1.5, comment: 'note' }],
      }),
    );
    expect(parsed).toEqual({
      comment: 'daily',
      recipients: [{ address: 'a@b.com', amountUsd: 1.5, comment: 'note' }],
    });
  });

  it('rejects invalid JSON, non-arrays, duplicates, and bad fields', () => {
    expect(() => parseRecipientsJson('{')).toThrow(CorruptRecipientsError);
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
    saveLiveRecipients(dir, { comment: 'x', recipients: [] });
    expect(loadLiveRecipients(dir)).toEqual({ comment: 'x', recipients: [] });
  });

  it('throws when the live file is missing or corrupt', () => {
    expect(() => loadLiveRecipients(tmp())).toThrow(CorruptRecipientsError);
    const dir = tmp();
    writeFileSync(join(dir, LIVE_RECIPIENTS_FILE), '{');
    expect(() => loadLiveRecipients(dir)).toThrow(CorruptRecipientsError);
  });
});
