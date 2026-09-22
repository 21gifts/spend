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

/** Parsed live file: daily roster, moderator roster, payment comment, and payment switches. */
export interface LiveRecipients {
  comment: string;
  recipients: Recipient[];
  moderators: Recipient[];
  paymentsEnabled: boolean;
  moderatorPaymentsEnabled: boolean;
}

interface RecipientsFile {
  comment?: unknown;
  recipients?: unknown;
  moderators?: unknown;
  paymentsEnabled?: unknown;
  moderatorPaymentsEnabled?: unknown;
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
 * Parse a payment-switch flag. Missing is enabled; any non-boolean present value is corrupt.
 *
 * @param raw - JSON value for the key.
 * @param key - Live-file key, used in the error message.
 * @returns The flag, defaulting to `true` when the key is absent.
 */
function parseEnabledFlag(
  raw: unknown,
  key: 'paymentsEnabled' | 'moderatorPaymentsEnabled',
): boolean {
  if (raw === undefined) {
    return true;
  }
  if (typeof raw === 'boolean') {
    return raw;
  }
  throw new CorruptRecipientsError(`${key} must be a boolean`);
}

/**
 * Parse recipients JSON text. Empty `recipients: []` is ok.
 * Missing `moderators` is `[]`. Missing `paymentsEnabled` or
 * `moderatorPaymentsEnabled` is `true`. Duplicates, bad usd, bad address, or a
 * non-boolean present switch throw {@link CorruptRecipientsError}.
 *
 * @param raw - File contents.
 * @returns Comment, daily rows, moderator rows, and both payment switches.
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
  const paymentsEnabled = parseEnabledFlag(parsed.paymentsEnabled, 'paymentsEnabled');
  const moderatorPaymentsEnabled = parseEnabledFlag(
    parsed.moderatorPaymentsEnabled,
    'moderatorPaymentsEnabled',
  );
  return { comment, recipients, moderators, paymentsEnabled, moderatorPaymentsEnabled };
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
 * @returns Comment, daily rows, moderator rows, and both payment switches.
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
 * Always writes `comment`, `recipients`, `moderators`, `paymentsEnabled`, and
 * `moderatorPaymentsEnabled`.
 *
 * @param stateDir - `STATE_DIR`.
 * @param data - Comment, both roster lists, and both payment switches to persist.
 */
export function saveLiveRecipients(stateDir: string, data: LiveRecipients): void {
  mkdirSync(stateDir, { recursive: true });
  const livePath = join(stateDir, LIVE_RECIPIENTS_FILE);
  const tmpPath = join(stateDir, `.recipients.json.${process.pid}.tmp`);
  const body = `${JSON.stringify(
    {
      comment: data.comment,
      recipients: data.recipients,
      moderators: data.moderators,
      paymentsEnabled: data.paymentsEnabled,
      moderatorPaymentsEnabled: data.moderatorPaymentsEnabled,
    },
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
