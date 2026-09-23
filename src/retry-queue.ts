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
  /** Present only for an unlisted daily ping. USD amount of the synthetic recipient. */
  amountUsd?: number;
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

/**
 * Load owed retry rows for a UTC day. Invalid lines are skipped.
 *
 * @param stateDir - `STATE_DIR`.
 * @param day - UTC calendar day `YYYY-MM-DD`.
 * @returns Valid rows (empty when the file is missing). First line per bucket+address wins.
 */
export function loadRetryOwed(stateDir: string, day: string): RetryOwed[] {
  const path = retryQueuePath(stateDir, day);
  if (!existsSync(path)) {
    return [];
  }
  const raw = readFileSync(path, 'utf8');
  const seen = new Set<string>();
  const rows: RetryOwed[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const row = parseRetryOwed(line);
    if (row === null) {
      continue;
    }
    const identity = retryIdentity(row.bucket, row.address);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    rows.push(row);
  }
  return rows;
}

/**
 * Append one owed row unless that bucket+address is already in the file.
 *
 * @param stateDir - `STATE_DIR`.
 * @param day - UTC calendar day `YYYY-MM-DD`.
 * @param row - Address to retry later this UTC day.
 */
export function appendRetryOwed(stateDir: string, day: string, row: RetryOwed): void {
  mkdirSync(stateDir, { recursive: true });
  const address = parseLightningAddress(row.address) ?? row.address.trim();
  const identity = retryIdentity(row.bucket, address);
  const existing = loadRetryOwed(stateDir, day);
  if (existing.some((item) => retryIdentity(item.bucket, item.address) === identity)) {
    return;
  }
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
  if (
    (row.bucket === 'daily' || row.bucket === 'welcome') &&
    typeof row.amountUsd === 'number' &&
    Number.isFinite(row.amountUsd) &&
    row.amountUsd > 0
  ) {
    persisted.amountUsd = row.amountUsd;
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
  return row;
}
