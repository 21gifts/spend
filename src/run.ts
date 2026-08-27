import type { SpendConfig } from './config';
import { GiftsApi, GiftsApiError } from './gifts-api';
import { LndhubClient, parseLndhubUri } from './lndhub';
import { fetchBtcUsdSpot, usdToSats } from './price';
import { hashPreimage } from './proof';
import { fileDayLock, type DayLock } from './lock';
import { CorruptStateError, DayState, dayBlock, type StateRow } from './state';

const HALT_ADDRESS = '*halt*';

/** CLI options for one run. */
export interface RunOptions {
  live: boolean;
  day: string;
}

/** Outcome of {@link runDay}. */
export interface RunResult {
  exitCode: number;
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

/**
 * Run one UTC day's gifts.
 *
 * @param config - Loaded operator config.
 * @param options - Live vs dry-run and the day key.
 * @param deps - Injected clients (tests).
 * @returns Process exit code.
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
    return { exitCode: 2 };
  }
  const lndhub = deps?.lndhub ?? new LndhubClient(target);
  const state = deps?.state ?? new DayState(config.stateDir, options.day);
  const now = deps?.now ?? (() => new Date());

  const lock = deps?.lock ?? fileDayLock(config.stateDir, options.day);
  if (!lock.tryAcquire()) {
    log('spend.done', { ok: false, reason: 'locked' });
    return { exitCode: 3 };
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
  let rows: StateRow[];
  try {
    rows = state.load();
  } catch (err) {
    if (err instanceof CorruptStateError) {
      log('spend.done', { ok: false, reason: 'corrupt_state' });
      return { exitCode: 4 };
    }
    throw err;
  }
  if (options.live) {
    const recipientUncertain = config.recipients.some(
      (recipient) => dayBlock(rows, recipient.address) === 'uncertain',
    );
    if (recipientUncertain || dayBlock(rows, HALT_ADDRESS) === 'uncertain') {
      log('spend.done', { ok: false, reason: 'halted' });
      return { exitCode: 4 };
    }
  }

  const rate = await (btcUsdSpot ?? fetchBtcUsdSpot)();
  if (rate === null) {
    log('spend.done', { ok: false, reason: 'spot_unreadable' });
    return { exitCode: 3 };
  }

  const satsByAddress = new Map<string, number>();
  for (const recipient of config.recipients) {
    const sats = usdToSats(recipient.amountUsd, rate);
    if (sats === null) {
      log('spend.done', {
        ok: false,
        reason: 'usd_to_sats',
        address: recipient.address,
        amountUsd: recipient.amountUsd,
        btcUsd: rate,
      });
      return { exitCode: 3 };
    }
    satsByAddress.set(recipient.address, sats);
  }

  log('spend.start', {
    live: options.live,
    day: options.day,
    recipients: config.recipients.length,
    btcUsd: rate,
  });

  let token = '';
  if (options.live) {
    const pending = config.recipients.filter((r) => dayBlock(rows, r.address) === undefined);
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
        return { exitCode: 3 };
      }
      available = bal;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'lndhub';
      log('spend.done', { ok: false, reason: 'lndhub_preflight', error: message });
      return { exitCode: 3 };
    }
    if (needed > 0 && needed + feeMargin(available) > available) {
      log('spend.done', { ok: false, reason: 'insufficient_balance', needed, available });
      return { exitCode: 3 };
    }
  }

  let sawProblem = false;
  let stopLive = false;

  const haltDay = (): void => {
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

  for (const recipient of config.recipients) {
    const prior = dayBlock(rows, recipient.address);
    if (prior !== undefined) {
      log('spend.skip', { address: recipient.address, reason: prior });
      continue;
    }
    if (stopLive && options.live) {
      log('spend.skip', { address: recipient.address, reason: 'halted' });
      continue;
    }

    const amountSats = satsByAddress.get(recipient.address);
    if (amountSats === undefined) {
      throw new Error('satsByAddress incomplete');
    }

    const comment = recipient.comment ?? config.comment;
    let invoice;
    try {
      invoice = await gifts.createInvoice(recipient.address, amountSats * 1000, comment);
    } catch (err) {
      const status = err instanceof GiftsApiError ? err.status : 0;
      const retryable = status === 0 || status >= 500;
      const rowStatus: StateRow['status'] = retryable ? 'uncertain' : 'failed';
      sawProblem = true;
      if (retryable) {
        stopLive = true;
        haltDay();
      }
      log(rowStatus === 'failed' ? 'spend.failed' : 'spend.uncertain', {
        address: recipient.address,
        amountSats,
        error: err instanceof Error ? err.message : 'invoice',
      });
      if (!options.live) {
        continue;
      }
      const failRow: StateRow = {
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: '',
        paymentHash: '',
        status: rowStatus,
      };
      state.append(failRow);
      rows.push(failRow);
      continue;
    }

    const expectedMsat = amountSats * 1000;
    if (invoice.amountMsat !== expectedMsat) {
      sawProblem = true;
      stopLive = true;
      haltDay();
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        amountSats,
        reason: 'amount_mismatch',
      });
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
      const paid = await lndhub.payInvoice(token, invoice.pr);
      preimage = paid.preimage;
    } catch (err) {
      sawProblem = true;
      stopLive = true;
      haltDay();
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        amountSats,
        error: err instanceof Error ? err.message : 'pay',
      });
      continue;
    }

    const digest = preimage === null ? null : hashPreimage(preimage);
    if (preimage === null || digest === null || digest !== invoice.paymentHash) {
      sawProblem = true;
      stopLive = true;
      haltDay();
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        amountSats,
        reason: 'preimage',
      });
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
      stopLive = true;
      haltDay();
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        amountSats,
        error: err instanceof Error ? err.message : 'proof',
      });
      continue;
    }

    log('spend.paid', {
      address: recipient.address,
      invoiceId: invoice.id,
      paymentHash: invoice.paymentHash,
      amountSats,
    });
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

  log('spend.done', { ok: !sawProblem });
  return { exitCode: sawProblem ? 4 : 0 };
}
