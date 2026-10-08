import type { SpendConfig } from './config';
import { GiftsApi, GiftsApiError } from './gifts-api';
import { LndhubClient, parseLndhubUri } from './lndhub';
import { fetchBtcUsdSpot, formatAmountUsd, usdToSats } from './price';
import { hashPreimage } from './proof';
import { fileDayLock, type DayLock } from './lock';
import { CorruptStateError, DayState, dayBlock, latestStatus, type StateRow } from './state';
import type { PayoutLine, RunSummary } from './telegram';

const HALT_ADDRESS = '*halt*';

/** CLI / ping options for one run. */
export interface RunOptions {
  live: boolean;
  day: string;
  /** When set, only these addresses are attempted (case-insensitive). Daily: they must be on the live roster. Moderator: the pinged address as listed on the moderator roster (the server gates the ping; the daily roster does not apply). Welcome: the pinged address as a synthetic one-address list (the daily roster does not apply). */
  onlyAddresses?: string[];
  /**
   * Optional map: lowercase lightning address → forum post UUID that triggered the gift.
   * Ping sets this for the one pinged address. CLI sets it from a pay instruction's
   * `messageId`. A run with no map does not send `messageId`.
   */
  messageIdByAddress?: Record<string, string>;
  /**
   * Optional map: lowercase lightning address → Moderators-group message UUID that
   * triggered the stipend. Ping sets this for the one pinged address when the body
   * included `groupMessageId`. Used only when {@link RunOptions.bucket} is `'moderator'`.
   */
  groupMessageIdByAddress?: Record<string, string>;
  /**
   * Default `'daily'`. Selects the state file: daily JSONL, moderator JSONL, or
   * dateless `welcome.jsonl`. Moderator never sends `messageId` on `createInvoice`
   * and sends `groupMessageId` when {@link RunOptions.groupMessageIdByAddress} has
   * one. Welcome and daily send `messageId` only when
   * {@link RunOptions.messageIdByAddress} has a string. There is no policy
   * preflight. `welcome.jsonl` is not read to block a daily run.
   */
  bucket?: 'daily' | 'moderator' | 'welcome';
}

/** Outcome of {@link runDay}. */
export interface RunResult {
  exitCode: number;
  summary: RunSummary;
}

function log(event: string, fields: Record<string, string | number | boolean>): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function prPreview(pr: string): string {
  if (pr.length <= 16) {
    return pr;
  }
  return `${pr.slice(0, 8)}…${pr.slice(-8)}`;
}

function feeMargin(availableSats: number): number {
  return Math.max(100, Math.ceil(availableSats * 0.01));
}

function emptyBags(): Pick<RunSummary, 'paid' | 'skipped' | 'failed' | 'uncertain' | 'dryRun'> {
  return { paid: [], skipped: [], failed: [], uncertain: [], dryRun: [] };
}

function makeSummary(
  options: RunOptions,
  exitCode: number,
  extra: Partial<Omit<RunSummary, 'day' | 'live' | 'ok' | 'exitCode'>> = {},
): RunSummary {
  return {
    day: options.day,
    live: options.live,
    ok: exitCode === 0,
    exitCode,
    ...emptyBags(),
    ...extra,
  };
}

function selectTargets(
  recipients: SpendConfig['recipients'],
  onlyAddresses: string[] | undefined,
): SpendConfig['recipients'] {
  if (onlyAddresses === undefined) {
    return recipients;
  }
  const wanted = new Set(onlyAddresses.map((address) => address.trim().toLowerCase()));
  return recipients.filter((recipient) => wanted.has(recipient.address.toLowerCase()));
}

/**
 * Run one UTC day's gifts (or a subset when {@link RunOptions.onlyAddresses} is set).
 *
 * Daily `markFinished` is against this run's recipient list; moderator `markFinished` is against the synthetic stipend recipient list for that run, not the living-room roster. Welcome `markFinished` writes `welcome.finished` (never the daily `${day}.finished`).
 * When {@link RunOptions.messageIdByAddress} is set, those post ids are sent on
 * `createInvoice`. A run with no map does not send `messageId`. There is no policy
 * preflight. Spend does not read `welcome.jsonl` to decide a daily skip. HTTP 403 with
 * error exactly `Welcome gift already paid` is recorded as skip reason `welcome_paid`
 * (any bucket) and writes no JSONL row; that skip does not set `summary.reason`.
 * HTTP 403 `Passkey required` is `no_passkey`. HTTP 403 `Forum post required` is
 * `no_media` for welcome and `no_post` otherwise. HTTP 403 `Funding grant required`
 * is `not_eligible` (any bucket). When {@link RunOptions.bucket} is `'moderator'`, uses
 * the moderator JSONL and never sends `messageId` on `createInvoice`. When
 * {@link RunOptions.bucket} is `'welcome'`, uses dateless `welcome.jsonl`. When
 * {@link RunOptions.groupMessageIdByAddress} has an entry for the recipient, that id
 * is sent as `groupMessageId` on `createInvoice` (moderator only).
 *
 * @param config - Loaded operator config.
 * @param options - Live vs dry-run, the day key, optional address filter, optional post-id map, optional group-message-id map, and optional bucket.
 * @param deps - Injected clients (tests).
 * @returns Process exit code and a structured summary for Telegram notify.
 */
export async function runDay(
  config: SpendConfig,
  options: RunOptions,
  deps?: {
    gifts?: GiftsApi;
    lndhub?: LndhubClient;
    state?: DayState;
    now?: () => Date;
    lock?: DayLock;
    btcUsd?: () => Promise<number | null>;
  },
): Promise<RunResult> {
  const gifts = deps?.gifts ?? new GiftsApi(config.giftsApiUrl, config.giftsApiToken);
  const target = parseLndhubUri(config.lndhubUri);
  if (target === null) {
    log('spend.done', { ok: false, reason: 'bad_lndhub_uri' });
    return {
      exitCode: 2,
      summary: makeSummary(options, 2, { reason: 'bad_lndhub_uri' }),
    };
  }
  const lndhub = deps?.lndhub ?? new LndhubClient(target);
  const state =
    deps?.state ?? new DayState(config.stateDir, options.day, undefined, options.bucket ?? 'daily');
  const now = deps?.now ?? (() => new Date());

  const lock = deps?.lock ?? fileDayLock(config.stateDir, options.day);
  if (!lock.tryAcquire()) {
    log('spend.done', { ok: false, reason: 'locked' });
    return {
      exitCode: 3,
      summary: makeSummary(options, 3, { reason: 'locked' }),
    };
  }

  try {
    return await runDayLocked(config, options, gifts, lndhub, state, now, deps?.btcUsd);
  } finally {
    lock.release();
  }
}

async function runDayLocked(
  config: SpendConfig,
  options: RunOptions,
  gifts: GiftsApi,
  lndhub: LndhubClient,
  state: DayState,
  now: () => Date,
  btcUsdSpot: (() => Promise<number | null>) | undefined,
): Promise<RunResult> {
  const paid: PayoutLine[] = [];
  const skipped: PayoutLine[] = [];
  const failed: PayoutLine[] = [];
  const uncertain: PayoutLine[] = [];
  const dryRun: PayoutLine[] = [];
  let btcUsd: number | undefined;
  const isolatedBucket = options.bucket === 'moderator' || options.bucket === 'welcome';

  const finish = (
    exitCode: number,
    extra: Partial<
      Omit<
        RunSummary,
        'day' | 'live' | 'ok' | 'exitCode' | 'paid' | 'skipped' | 'failed' | 'uncertain' | 'dryRun'
      >
    > = {},
  ): RunResult => ({
    exitCode,
    summary: makeSummary(options, exitCode, {
      paid,
      skipped,
      failed,
      uncertain,
      dryRun,
      ...(btcUsd !== undefined ? { btcUsd } : {}),
      ...extra,
    }),
  });

  let rows: StateRow[];
  try {
    rows = state.load();
  } catch (err) {
    if (err instanceof CorruptStateError) {
      log('spend.done', { ok: false, reason: 'corrupt_state' });
      return finish(4, { reason: 'corrupt_state' });
    }
    throw err;
  }
  if (options.live && !isolatedBucket) {
    const recipientUncertain = config.recipients.some(
      (recipient) => dayBlock(rows, recipient.address) === 'uncertain',
    );
    if (recipientUncertain || dayBlock(rows, HALT_ADDRESS) === 'uncertain') {
      log('spend.done', { ok: false, reason: 'halted' });
      state.markFinished();
      return finish(4, { reason: 'halted' });
    }
  }

  const rate = await (btcUsdSpot ?? fetchBtcUsdSpot)();
  if (rate === null) {
    log('spend.done', { ok: false, reason: 'spot_unreadable' });
    return finish(3, { reason: 'spot_unreadable' });
  }
  btcUsd = rate;

  const targets = selectTargets(config.recipients, options.onlyAddresses);

  const satsByAddress = new Map<string, number>();
  const amountUsdByAddress = new Map<string, string>();
  for (const recipient of targets) {
    const sats = usdToSats(recipient.amountUsd, rate);
    if (sats === null) {
      log('spend.done', {
        ok: false,
        reason: 'usd_to_sats',
        address: recipient.address,
        amountUsd: recipient.amountUsd,
        btcUsd: rate,
      });
      failed.push({
        address: recipient.address,
        amountUsd: recipient.amountUsd,
        reason: 'usd_to_sats',
      });
      return finish(3, { reason: 'usd_to_sats' });
    }
    const formattedUsd = formatAmountUsd(recipient.amountUsd);
    if (formattedUsd === null) {
      log('spend.done', {
        ok: false,
        reason: 'usd_to_sats',
        address: recipient.address,
        amountUsd: recipient.amountUsd,
        btcUsd: rate,
      });
      failed.push({ address: recipient.address, amountUsd: recipient.amountUsd, reason: 'usd_to_sats' });
      return finish(3, { reason: 'usd_to_sats' });
    }
    satsByAddress.set(recipient.address, sats);
    amountUsdByAddress.set(recipient.address, formattedUsd);
  }

  log('spend.start', {
    live: options.live,
    day: options.day,
    recipients: targets.length,
    btcUsd: rate,
  });

  let token = '';
  if (options.live) {
    const pending = targets.filter(
      (r) => dayBlock(rows, r.address) === undefined && latestStatus(rows, r.address) !== 'failed',
    );
    const needed = pending.reduce((sum, r) => {
      const sats = satsByAddress.get(r.address);
      if (sats === undefined) {
        throw new Error('satsByAddress incomplete');
      }
      return sum + sats;
    }, 0);
    let available: number;
    try {
      token = await lndhub.auth();
      const bal = await lndhub.balance(token);
      if (bal === null) {
        log('spend.done', { ok: false, reason: 'balance_unreadable' });
        return finish(3, { reason: 'balance_unreadable' });
      }
      available = bal;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'lndhub';
      log('spend.done', {
        ok: false,
        reason: 'lndhub_preflight',
        error: message,
      });
      return finish(3, { reason: 'lndhub_preflight' });
    }
    if (needed > 0 && needed + feeMargin(available) > available) {
      log('spend.done', {
        ok: false,
        reason: 'insufficient_balance',
        needed,
        available,
      });
      return finish(3, { reason: 'insufficient_balance', needed, available });
    }
  }

  let sawProblem = false;
  let stopLive = false;

  const haltDay = (): void => {
    if (isolatedBucket) {
      return;
    }
    if (!options.live || dayBlock(rows, HALT_ADDRESS) === 'uncertain') {
      return;
    }
    const halt: StateRow = {
      ts: now().toISOString(),
      address: HALT_ADDRESS,
      invoiceId: '',
      paymentHash: '',
      status: 'uncertain',
    };
    state.append(halt);
    rows.push(halt);
  };

  for (const recipient of targets) {
    const amountSats = satsByAddress.get(recipient.address);
    const formattedUsd = amountUsdByAddress.get(recipient.address);
    if (amountSats === undefined || formattedUsd === undefined) {
      throw new Error('satsByAddress incomplete');
    }
    const lineBase = {
      address: recipient.address,
      amountSats,
      amountUsd: recipient.amountUsd,
    };

    const prior = dayBlock(rows, recipient.address);
    if (prior !== undefined) {
      log('spend.skip', { address: recipient.address, reason: prior });
      skipped.push({ ...lineBase, reason: prior });
      continue;
    }
    if (latestStatus(rows, recipient.address) === 'failed') {
      log('spend.skip', { address: recipient.address, reason: 'failed' });
      skipped.push({ ...lineBase, reason: 'failed' });
      continue;
    }
    if (stopLive && options.live) {
      log('spend.skip', { address: recipient.address, reason: 'halted' });
      skipped.push({ ...lineBase, reason: 'halted' });
      continue;
    }

    const comment = recipient.comment ?? config.comment;
    const mappedId = options.messageIdByAddress?.[recipient.address.toLowerCase()];
    const invoiceMessageId =
      options.bucket === 'moderator'
        ? undefined
        : typeof mappedId === 'string'
          ? mappedId
          : undefined;
    const groupMessageId =
      options.bucket === 'moderator'
        ? options.groupMessageIdByAddress?.[recipient.address.toLowerCase()]
        : undefined;
    let invoice;
    try {
      invoice =
        invoiceMessageId === undefined
          ? groupMessageId === undefined
            ? await gifts.createInvoice(recipient.address, amountSats * 1000, formattedUsd, comment)
            : await gifts.createInvoice(
                recipient.address,
                amountSats * 1000,
                formattedUsd,
                comment,
                undefined,
                groupMessageId,
              )
          : await gifts.createInvoice(
              recipient.address,
              amountSats * 1000,
              formattedUsd,
              comment,
              invoiceMessageId,
            );
    } catch (err) {
      if (err instanceof GiftsApiError && err.status === 409) {
        log('spend.skip', {
          address: recipient.address,
          reason: 'already_paid',
        });
        skipped.push({ ...lineBase, reason: 'already_paid' });
        const claimed: StateRow = {
          ts: now().toISOString(),
          address: recipient.address,
          invoiceId: 'already-paid',
          paymentHash: '0'.repeat(64),
          status: 'paid',
        };
        state.append(claimed);
        rows.push(claimed);
        continue;
      }
      if (
        err instanceof GiftsApiError &&
        err.status === 403 &&
        err.message === 'Passkey required'
      ) {
        log('spend.skip', { address: recipient.address, reason: 'no_passkey' });
        skipped.push({ ...lineBase, reason: 'no_passkey' });
        continue;
      }
      if (
        err instanceof GiftsApiError &&
        err.status === 403 &&
        err.message === 'Welcome gift already paid'
      ) {
        log('spend.skip', { address: recipient.address, reason: 'welcome_paid' });
        skipped.push({ ...lineBase, reason: 'welcome_paid' });
        continue;
      }
      if (
        err instanceof GiftsApiError &&
        err.status === 403 &&
        err.message === 'Forum post required'
      ) {
        const reason = options.bucket === 'welcome' ? 'no_media' : 'no_post';
        log('spend.skip', { address: recipient.address, reason });
        skipped.push({ ...lineBase, reason });
        continue;
      }
      if (
        err instanceof GiftsApiError &&
        err.status === 403 &&
        err.message === 'Funding grant required'
      ) {
        log('spend.skip', { address: recipient.address, reason: 'not_eligible' });
        skipped.push({ ...lineBase, reason: 'not_eligible' });
        continue;
      }
      const status = err instanceof GiftsApiError ? err.status : 0;
      const message = err instanceof Error ? err.message : 'invoice';
      const parseFail =
        message === 'malformed invoice response' || message === 'malformed paymentHash';
      const unreachable = !parseFail && (status === 0 || status >= 500);
      if (unreachable) {
        log('spend.skip', {
          address: recipient.address,
          reason: 'invoice_unreachable',
        });
        skipped.push({ ...lineBase, reason: 'invoice_unreachable' });
        continue;
      }
      if (parseFail) {
        sawProblem = true;
        if (!isolatedBucket) {
          stopLive = true;
        }
        haltDay();
        log('spend.uncertain', {
          address: recipient.address,
          amountSats,
          error: message,
        });
        uncertain.push(lineBase);
        if (!options.live) {
          continue;
        }
        const failRow: StateRow = {
          ts: now().toISOString(),
          address: recipient.address,
          invoiceId: '',
          paymentHash: '',
          status: 'uncertain',
        };
        state.append(failRow);
        rows.push(failRow);
        continue;
      }
      sawProblem = true;
      log('spend.failed', {
        address: recipient.address,
        amountSats,
        error: message,
      });
      failed.push(lineBase);
      if (!options.live) {
        continue;
      }
      const failRow: StateRow = {
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: '',
        paymentHash: '',
        status: 'failed',
      };
      state.append(failRow);
      rows.push(failRow);
      continue;
    }

    const expectedMsat = amountSats * 1000;
    if (invoice.amountMsat !== expectedMsat) {
      sawProblem = true;
      if (!isolatedBucket) {
        stopLive = true;
      }
      haltDay();
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        amountSats,
        reason: 'amount_mismatch',
      });
      uncertain.push({ ...lineBase, reason: 'amount_mismatch' });
      if (!options.live) {
        continue;
      }
      const mismatch: StateRow = {
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        status: 'uncertain',
      };
      state.append(mismatch);
      rows.push(mismatch);
      continue;
    }

    log('spend.invoice', {
      address: recipient.address,
      invoiceId: invoice.id,
      paymentHash: invoice.paymentHash,
      amountSats,
      pr: prPreview(invoice.pr),
    });

    if (!options.live) {
      const dry: StateRow = {
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        status: 'dry-run',
      };
      state.append(dry);
      rows.push(dry);
      dryRun.push(lineBase);
      continue;
    }

    const attempting: StateRow = {
      ts: now().toISOString(),
      address: recipient.address,
      invoiceId: invoice.id,
      paymentHash: invoice.paymentHash,
      status: 'uncertain',
    };
    state.append(attempting);
    rows.push(attempting);

    let preimage: string | null;
    try {
      const paidInvoice = await lndhub.payInvoice(token, invoice.pr);
      preimage = paidInvoice.preimage;
    } catch (err) {
      sawProblem = true;
      if (!isolatedBucket) {
        stopLive = true;
      }
      haltDay();
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        amountSats,
        error: err instanceof Error ? err.message : 'pay',
      });
      uncertain.push(lineBase);
      continue;
    }

    const digest = preimage === null ? null : hashPreimage(preimage);
    if (preimage === null || digest === null || digest !== invoice.paymentHash) {
      sawProblem = true;
      if (!isolatedBucket) {
        stopLive = true;
      }
      haltDay();
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        amountSats,
        reason: 'preimage',
      });
      uncertain.push({ ...lineBase, reason: 'preimage' });
      const preFail: StateRow = {
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        status: 'uncertain',
      };
      state.append(preFail);
      rows.push(preFail);
      continue;
    }

    const paidUnproven: StateRow = {
      ts: now().toISOString(),
      address: recipient.address,
      invoiceId: invoice.id,
      paymentHash: invoice.paymentHash,
      status: 'uncertain',
    };
    state.append(paidUnproven);
    rows.push(paidUnproven);

    try {
      await gifts.submitProof(invoice.id, preimage);
    } catch (err) {
      sawProblem = true;
      if (!isolatedBucket) {
        stopLive = true;
      }
      haltDay();
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        amountSats,
        error: err instanceof Error ? err.message : 'proof',
      });
      uncertain.push(lineBase);
      continue;
    }

    log('spend.paid', {
      address: recipient.address,
      invoiceId: invoice.id,
      paymentHash: invoice.paymentHash,
      amountSats,
    });
    paid.push(lineBase);
    const paidRow: StateRow = {
      ts: now().toISOString(),
      address: recipient.address,
      invoiceId: invoice.id,
      paymentHash: invoice.paymentHash,
      status: 'paid',
    };
    state.append(paidRow);
    rows.push(paidRow);
  }

  const settled = config.recipients.every(
    (r) => dayBlock(rows, r.address) !== undefined || latestStatus(rows, r.address) === 'failed',
  );
  const halted =
    dayBlock(rows, HALT_ADDRESS) === 'uncertain' ||
    config.recipients.some((r) => dayBlock(rows, r.address) === 'uncertain');
  const unfinished = skipped.some((line) => line.reason === 'invoice_unreachable');
  if (halted) {
    state.markFinished();
    log('spend.done', { ok: false });
    return finish(4);
  }
  if (unfinished) {
    log('spend.done', { ok: false, reason: 'invoice_unreachable' });
    return finish(3);
  }
  if (settled) state.markFinished();
  log('spend.done', { ok: !sawProblem });
  return finish(sawProblem ? 4 : 0);
}
