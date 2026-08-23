import type { SpendConfig } from './config';
import { GiftsApi, GiftsApiError } from './gifts-api';
import { LndhubClient, parseLndhubUri } from './lndhub';
import { hashPreimage } from './proof';
import { DayState, latestStatus, type StateRow } from './state';

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

  const rows = state.load();
  log('spend.start', { live: options.live, day: options.day, recipients: config.recipients.length });

  let token: string;
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

  const pending = config.recipients.filter((r) => {
    const status = latestStatus(rows, r.address);
    return status !== 'paid' && status !== 'uncertain';
  });
  const needed = pending.reduce((sum, r) => sum + r.amountSats, 0);
  if (needed + feeMargin(available) > available) {
    log('spend.done', { ok: false, reason: 'insufficient_balance', needed, available });
    return { exitCode: 3 };
  }

  let sawProblem = false;
  let stopLive = false;

  for (const recipient of config.recipients) {
    const prior = latestStatus(rows, recipient.address);
    if (prior === 'paid' || prior === 'uncertain') {
      log('spend.skip', { address: recipient.address, reason: prior });
      continue;
    }
    if (stopLive && options.live) {
      log('spend.skip', { address: recipient.address, reason: 'halted' });
      continue;
    }

    const comment = recipient.comment ?? config.comment;
    let invoice;
    try {
      invoice = await gifts.createInvoice(recipient.address, recipient.amountSats * 1000, comment);
    } catch (err) {
      const status = err instanceof GiftsApiError ? err.status : 0;
      const retryable = status === 0 || status >= 500;
      const rowStatus: StateRow['status'] = retryable ? 'uncertain' : 'failed';
      sawProblem = true;
      if (retryable) {
        stopLive = true;
      }
      log('spend.uncertain', { address: recipient.address, error: err instanceof Error ? err.message : 'invoice' });
      state.append({
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: '',
        paymentHash: '',
        status: rowStatus,
      });
      continue;
    }

    log('spend.invoice', {
      address: recipient.address,
      invoiceId: invoice.id,
      paymentHash: invoice.paymentHash,
      amountSats: recipient.amountSats,
      pr: prPreview(invoice.pr),
    });

    if (!options.live) {
      state.append({
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        status: 'dry-run',
      });
      continue;
    }

    let preimage: string | null;
    try {
      const paid = await lndhub.payInvoice(token, invoice.pr);
      preimage = paid.preimage;
    } catch (err) {
      sawProblem = true;
      stopLive = true;
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : 'pay',
      });
      state.append({
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        status: 'uncertain',
      });
      continue;
    }

    const digest = preimage === null ? null : hashPreimage(preimage);
    if (preimage === null || digest === null || digest !== invoice.paymentHash) {
      sawProblem = true;
      stopLive = true;
      log('spend.uncertain', { address: recipient.address, invoiceId: invoice.id, reason: 'preimage' });
      state.append({
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        status: 'uncertain',
      });
      continue;
    }

    try {
      await gifts.submitProof(invoice.id, preimage);
    } catch (err) {
      sawProblem = true;
      stopLive = true;
      log('spend.uncertain', {
        address: recipient.address,
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : 'proof',
      });
      state.append({
        ts: now().toISOString(),
        address: recipient.address,
        invoiceId: invoice.id,
        paymentHash: invoice.paymentHash,
        status: 'uncertain',
      });
      continue;
    }

    log('spend.paid', {
      address: recipient.address,
      invoiceId: invoice.id,
      paymentHash: invoice.paymentHash,
      amountSats: recipient.amountSats,
    });
    state.append({
      ts: now().toISOString(),
      address: recipient.address,
      invoiceId: invoice.id,
      paymentHash: invoice.paymentHash,
      status: 'paid',
    });
  }

  log('spend.done', { ok: !sawProblem });
  return { exitCode: sawProblem ? 4 : 0 };
}
