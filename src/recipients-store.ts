import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Recipient } from './config';

/** Basename of the live recipients file under `STATE_DIR`. */
export const LIVE_RECIPIENTS_FILE = 'recipients.json';

/** Unreadable, truncated, or invalid live/seed recipients JSON. */
export class CorruptRecipientsError extends Error {
  constructor(message = 'corrupt recipients') {
    super(message);
    this.name = 'CorruptRecipientsError';
  }
}

/** Parsed live file: daily roster, moderator roster, and payment comment. */
export interface LiveRecipients {
  comment: string;
  recipients: Recipient[];
  moderators: Recipient[];
}

interface RecipientsFile {
  comment?: unknown;
  recipients?: unknown;
  moderators?: unknown;
}

/**
 * Parse one roster array. `noun` is `"recipient"` or `"moderator"` in error text.
 *
 * @param raw - JSON value that must be an array of roster rows.
 * @param noun - Singular label used in {@link CorruptRecipientsError} messages.
 * @returns Parsed rows.
 */
function parseRosterRows(raw: unknown, noun: 'recipient' | 'moderator'): Recipient[] {
  const listName = noun === 'recipient' ? 'recipients' : 'moderators';
  if (!Array.isArray(raw)) {
    throw new CorruptRecipientsError(`${listName} must be an array`);
  }
  const rows: Recipient[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      throw new CorruptRecipientsError(`each ${noun} must be an object`);
    }
    const rec = item as { address?: unknown; amountUsd?: unknown; comment?: unknown };
    if (typeof rec.address !== 'string') {
      throw new CorruptRecipientsError(`each ${noun} needs a Lightning Address`);
    }
    const address = rec.address.trim();
    if (address === '' || !address.includes('@')) {
      throw new CorruptRecipientsError(`each ${noun} needs a Lightning Address`);
    }
    if (typeof rec.amountUsd !== 'number' || !Number.isFinite(rec.amountUsd) || rec.amountUsd <= 0) {
      throw new CorruptRecipientsError(`each ${noun} needs amountUsd > 0`);
    }
    const row: Recipient = { address, amountUsd: rec.amountUsd };
    if (typeof rec.comment === 'string') {
      row.comment = rec.comment;
    }
    if (rows.some((existing) => existing.address === row.address)) {
      throw new CorruptRecipientsError(`duplicate ${noun} address ${row.address}`);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Parse recipients JSON text. Empty `recipients: []` is ok.
 * Missing `moderators` is `[]`. Duplicates, bad usd, or bad address throw
 * {@link CorruptRecipientsError}.
 *
 * @param raw - File contents.
 * @returns Comment, daily rows, and moderator rows.
 */
export function parseRecipientsJson(raw: string): LiveRecipients {
  let parsed: RecipientsFile;
  try {
    parsed = JSON.parse(raw) as RecipientsFile;
  } catch {
    throw new CorruptRecipientsError('recipients JSON is not valid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CorruptRecipientsError('recipients JSON is not valid');
  }
  const comment = typeof parsed.comment === 'string' ? parsed.comment : '21gifts daily';
  const recipients = parseRosterRows(parsed.recipients, 'recipient');
  const moderators =
    parsed.moderators === undefined ? [] : parseRosterRows(parsed.moderators, 'moderator');
  return { comment, recipients, moderators };
}

/**
 * If `join(stateDir, 'recipients.json')` is missing, copy the seed file bytes
 * into it via tmp + fsync + `copyFileSync(..., COPYFILE_EXCL)`. Never overwrites
 * an existing live file.
 *
 * @param stateDir - `STATE_DIR`.
 * @param seedPath - `RECIPIENTS_FILE` seed path.
 */
export function ensureLiveRecipients(stateDir: string, seedPath: string): void {
  const livePath = join(stateDir, LIVE_RECIPIENTS_FILE);
  let seedBytes: Buffer;
  try {
    seedBytes = readFileSync(seedPath);
  } catch {
    throw new CorruptRecipientsError(`cannot read seed recipients file ${seedPath}`);
  }
  mkdirSync(stateDir, { recursive: true });
  const tmpPath = join(stateDir, `.recipients.json.${process.pid}.tmp`);
  const fd = openSync(tmpPath, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY);
  try {
    writeSync(fd, seedBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    copyFileSync(tmpPath, livePath, constants.COPYFILE_EXCL);
  } catch (err) {
    /* v8 ignore next 3 — disk errors other than a live file already present */
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
  unlinkSync(tmpPath);
}

/**
 * Read the live recipients file. Missing or corrupt → {@link CorruptRecipientsError}.
 *
 * @param stateDir - `STATE_DIR`.
 * @returns Comment, daily rows, and moderator rows.
 */
export function loadLiveRecipients(stateDir: string): LiveRecipients {
  const livePath = join(stateDir, LIVE_RECIPIENTS_FILE);
  let raw: string;
  try {
    raw = readFileSync(livePath, 'utf8');
  } catch {
    throw new CorruptRecipientsError(`cannot read live recipients file ${livePath}`);
  }
  return parseRecipientsJson(raw);
}

/**
 * Atomically replace the live recipients file (tmp in stateDir + fsync + rename).
 * Always writes `comment`, `recipients`, and `moderators`.
 *
 * @param stateDir - `STATE_DIR`.
 * @param data - Comment and both roster lists to persist.
 */
export function saveLiveRecipients(stateDir: string, data: LiveRecipients): void {
  mkdirSync(stateDir, { recursive: true });
  const livePath = join(stateDir, LIVE_RECIPIENTS_FILE);
  const tmpPath = join(stateDir, `.recipients.json.${process.pid}.tmp`);
  const body = `${JSON.stringify(
    { comment: data.comment, recipients: data.recipients, moderators: data.moderators },
    null,
    2,
  )}\n`;
  const fd = openSync(tmpPath, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, livePath);
}
