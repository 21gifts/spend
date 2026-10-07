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
import { join } from 'node:path';
import { parseLightningAddress } from './lightning-address';

const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One owed Lightning Address to retry later the same UTC day. */
export interface RetryOwed {
  address: string;
  bucket: 'daily' | 'moderator' | 'welcome';
  messageId?: string;
  groupMessageId?: string;
  /** Instructed USD amount. Missing on old lines; those stay unpaid. */
  amountUsd?: number;
  /** Instructed invoice comment. Missing on old lines; those stay unpaid. */
  comment?: string;
}

/**
 * Path of the owed-address retry queue for a UTC day.
 *
 * @param stateDir - `STATE_DIR`.
 * @param day - UTC calendar day `YYYY-MM-DD`.
 * @returns `${stateDir}/${day}.retry.jsonl`.
 */
export function retryQueuePath(stateDir: string, day: string): string {
  return join(stateDir, `${day}.retry.jsonl`);
}

/** True when the row carries both the instructed amount and the comment. */
function instructionComplete(row: Pick<RetryOwed, 'amountUsd' | 'comment'>): boolean {
  return typeof row.amountUsd === 'number' && typeof row.comment === 'string';
}

/**
 * Load owed retry rows for a UTC day. Invalid lines are skipped.
 *
 * @param stateDir - `STATE_DIR`.
 * @param day - UTC calendar day `YYYY-MM-DD`.
 * @returns Valid rows (empty when the file is missing). The first complete
 * instruction per bucket+address wins. An earlier line missing `amountUsd`
 * or `comment` is returned only when no later complete line exists.
 */
export function loadRetryOwed(stateDir: string, day: string): RetryOwed[] {
  const path = retryQueuePath(stateDir, day);
  if (!existsSync(path)) {
    return [];
  }
  const raw = readFileSync(path, 'utf8');
  const rows: RetryOwed[] = [];
  const indexByIdentity = new Map<string, number>();
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const row = parseRetryOwed(line);
    if (row === null) {
      continue;
    }
    const identity = retryIdentity(row.bucket, row.address);
    const priorIndex = indexByIdentity.get(identity);
    if (priorIndex === undefined) {
      indexByIdentity.set(identity, rows.length);
      rows.push(row);
      continue;
    }
    const prior = rows[priorIndex];
    if (prior !== undefined && !instructionComplete(prior) && instructionComplete(row)) {
      rows[priorIndex] = row;
    }
  }
  return rows;
}

/**
 * Append one owed row. A complete instruction is written unless that
 * bucket+address already has one. An incomplete row is written only when
 * that identity is not already in the file.
 *
 * @param stateDir - `STATE_DIR`.
 * @param day - UTC calendar day `YYYY-MM-DD`.
 * @param row - Address to retry later this UTC day.
 */
export function appendRetryOwed(stateDir: string, day: string, row: RetryOwed): void {
  mkdirSync(stateDir, { recursive: true });
  const address = parseLightningAddress(row.address) ?? row.address.trim();
  const identity = retryIdentity(row.bucket, address);
  const persisted: RetryOwed = { address, bucket: row.bucket };
  if (
    (row.bucket === 'daily' || row.bucket === 'welcome') &&
    typeof row.messageId === 'string' &&
    MESSAGE_ID_RE.test(row.messageId)
  ) {
    persisted.messageId = row.messageId;
  }
  if (
    row.bucket === 'moderator' &&
    typeof row.groupMessageId === 'string' &&
    MESSAGE_ID_RE.test(row.groupMessageId)
  ) {
    persisted.groupMessageId = row.groupMessageId;
  }
  if (typeof row.amountUsd === 'number' && Number.isFinite(row.amountUsd) && row.amountUsd > 0) {
    persisted.amountUsd = row.amountUsd;
  }
  if (typeof row.comment === 'string' && row.comment.length <= 500) {
    persisted.comment = row.comment;
  }
  const same = loadRetryOwed(stateDir, day).filter(
    (item) => retryIdentity(item.bucket, item.address) === identity,
  );
  if (same.some((item) => instructionComplete(item))) {
    return;
  }
  if (!instructionComplete(persisted) && same.length > 0) {
    return;
  }
  const path = retryQueuePath(stateDir, day);
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY);
  try {
    writeSync(fd, `${JSON.stringify(persisted)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function retryIdentity(bucket: RetryOwed['bucket'], address: string): string {
  return `${bucket}|${address.toLowerCase()}`;
}

function parseRetryOwed(line: string): RetryOwed | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  const bucket = rec['bucket'];
  if (bucket !== 'daily' && bucket !== 'moderator' && bucket !== 'welcome') {
    return null;
  }
  if (typeof rec['address'] !== 'string') {
    return null;
  }
  const address = parseLightningAddress(rec['address']);
  if (address === null) {
    return null;
  }
  const row: RetryOwed = { address, bucket };
  if ('messageId' in rec) {
    const messageId = rec['messageId'];
    if (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
      return null;
    }
    row.messageId = messageId;
  }
  if ('groupMessageId' in rec) {
    const groupMessageId = rec['groupMessageId'];
    if (typeof groupMessageId !== 'string' || !MESSAGE_ID_RE.test(groupMessageId)) {
      return null;
    }
    row.groupMessageId = groupMessageId;
  }
  if ('amountUsd' in rec) {
    const amountUsd = rec['amountUsd'];
    if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      return null;
    }
    row.amountUsd = amountUsd;
  }
  if ('comment' in rec) {
    const comment = rec['comment'];
    if (typeof comment !== 'string' || comment.length > 500) {
      return null;
    }
    row.comment = comment;
  }
  return row;
}
