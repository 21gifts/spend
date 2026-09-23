import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendRetryOwed, loadRetryOwed, retryQueuePath } from '../retry-queue';

const DAY = '2026-08-25';
const MESSAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_MESSAGE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const GROUP_MESSAGE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'spend-retry-q-'));
}

describe('retryQueuePath', () => {
  it(`ends with ${DAY}.retry.jsonl`, () => {
    expect(retryQueuePath('/state', DAY).endsWith(`${DAY}.retry.jsonl`)).toBe(true);
  });
});

describe('appendRetryOwed / loadRetryOwed', () => {
  it('roundtrips a daily row with messageId and amountUsd and a moderator row without amountUsd', () => {
    const dir = tmp();
    try {
      appendRetryOwed(dir, DAY, {
        address: ' alice@walletofsatoshi.com ',
        bucket: 'daily',
        messageId: MESSAGE_ID,
        amountUsd: 1,
      });
      appendRetryOwed(dir, DAY, {
        address: 'bob@walletofsatoshi.com',
        bucket: 'moderator',
        groupMessageId: GROUP_MESSAGE_ID,
        amountUsd: 7.5,
      });
      expect(loadRetryOwed(dir, DAY)).toEqual([
        {
          address: 'alice@walletofsatoshi.com',
          bucket: 'daily',
          messageId: MESSAGE_ID,
          amountUsd: 1,
        },
        {
          address: 'bob@walletofsatoshi.com',
          bucket: 'moderator',
          groupMessageId: GROUP_MESSAGE_ID,
        },
      ]);
      const lines = readFileSync(retryQueuePath(dir, DAY), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines[1]).not.toHaveProperty('amountUsd');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not replace the first messageId or write a second line for the same identity', () => {
    const dir = tmp();
    try {
      appendRetryOwed(dir, DAY, {
        address: 'alice@walletofsatoshi.com',
        bucket: 'daily',
        messageId: MESSAGE_ID,
        amountUsd: 1,
      });
      appendRetryOwed(dir, DAY, {
        address: 'ALICE@walletofsatoshi.com',
        bucket: 'daily',
        messageId: OTHER_MESSAGE_ID,
        amountUsd: 2,
      });
      expect(loadRetryOwed(dir, DAY)).toEqual([
        {
          address: 'alice@walletofsatoshi.com',
          bucket: 'daily',
          messageId: MESSAGE_ID,
          amountUsd: 1,
        },
      ]);
      const lines = readFileSync(retryQueuePath(dir, DAY), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(MESSAGE_ID);
      expect(lines[0]).not.toContain(OTHER_MESSAGE_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a corrupt JSON line and keeps a following valid line', () => {
    const dir = tmp();
    try {
      writeFileSync(
        retryQueuePath(dir, DAY),
        `not-json\n${JSON.stringify({
          address: 'alice@walletofsatoshi.com',
          bucket: 'daily',
          messageId: MESSAGE_ID,
        })}\n`,
      );
      expect(loadRetryOwed(dir, DAY)).toEqual([
        {
          address: 'alice@walletofsatoshi.com',
          bucket: 'daily',
          messageId: MESSAGE_ID,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when the file is missing', () => {
    const dir = tmp();
    try {
      expect(loadRetryOwed(dir, DAY)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a bad address, bad bucket, bad UUID, and non-positive or non-number amountUsd', () => {
    const dir = tmp();
    try {
      const valid = {
        address: 'ok@walletofsatoshi.com',
        bucket: 'daily',
        messageId: MESSAGE_ID,
      };
      writeFileSync(
        retryQueuePath(dir, DAY),
        [
          JSON.stringify({ address: 'not-an-address', bucket: 'daily' }),
          JSON.stringify({ address: 'alice@walletofsatoshi.com', bucket: 'other' }),
          JSON.stringify({
            address: 'alice@walletofsatoshi.com',
            bucket: 'daily',
            messageId: 'not-a-uuid',
          }),
          JSON.stringify({ address: 'alice@walletofsatoshi.com', bucket: 'daily', amountUsd: 0 }),
          JSON.stringify({ address: 'alice@walletofsatoshi.com', bucket: 'daily', amountUsd: -1 }),
          JSON.stringify({ address: 'alice@walletofsatoshi.com', bucket: 'daily', amountUsd: '1' }),
          JSON.stringify(valid),
        ].join('\n') + '\n',
      );
      expect(loadRetryOwed(dir, DAY)).toEqual([valid]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps daily and moderator rows with the same address as two identities', () => {
    const dir = tmp();
    try {
      appendRetryOwed(dir, DAY, {
        address: 'alice@walletofsatoshi.com',
        bucket: 'daily',
        messageId: MESSAGE_ID,
      });
      appendRetryOwed(dir, DAY, {
        address: 'alice@walletofsatoshi.com',
        bucket: 'moderator',
        groupMessageId: GROUP_MESSAGE_ID,
      });
      expect(loadRetryOwed(dir, DAY)).toEqual([
        {
          address: 'alice@walletofsatoshi.com',
          bucket: 'daily',
          messageId: MESSAGE_ID,
        },
        {
          address: 'alice@walletofsatoshi.com',
          bucket: 'moderator',
          groupMessageId: GROUP_MESSAGE_ID,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
