import { displayLightningAddress } from './html-shell';

/** Who triggered the payout that may notify Telegram. */
export type TelegramSource = 'scheduler' | 'catchup' | 'cli';

/** Resolved bot credentials for {@link notifyPayout}. */
export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

/** One recipient line in a {@link RunSummary}. */
export interface PayoutLine {
  address: string;
  amountSats?: number;
  amountUsd?: number;
  reason?: string;
}

/** Structured outcome of one {@link runDay} for Telegram and callers. */
export interface RunSummary {
  day: string;
  live: boolean;
  ok: boolean;
  /** Process exit code for this run; kept for the notify message. */
  exitCode: number;
  reason?: string;
  btcUsd?: number;
  needed?: number;
  available?: number;
  paid: PayoutLine[];
  skipped: PayoutLine[];
  failed: PayoutLine[];
  uncertain: PayoutLine[];
  dryRun: PayoutLine[];
}

const TOKEN_RE = /^[0-9]{6,12}:[A-Za-z0-9_-]{20,}$/;
const CHAT_ID_RE = /^-?[0-9]+$/;

function trimOrEmpty(value: string | undefined): string {
  return value === undefined ? '' : value.trim();
}

/**
 * Read optional Telegram env. Both empty disables notify; one set or bad format fails closed.
 *
 * @param env - Process env.
 * @returns Target, `null` when disabled, or an English error.
 */
export function loadTelegram(
  env: Record<string, string | undefined>,
): { ok: true; target: TelegramTarget | null } | { ok: false; error: string } {
  const botToken = trimOrEmpty(env['TELEGRAM_BOT_TOKEN']);
  const chatId = trimOrEmpty(env['TELEGRAM_CHAT_ID']);
  if (botToken === '' && chatId === '') {
    return { ok: true, target: null };
  }
  if (botToken === '') {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN is required when TELEGRAM_CHAT_ID is set' };
  }
  if (chatId === '') {
    return { ok: false, error: 'TELEGRAM_CHAT_ID is required when TELEGRAM_BOT_TOKEN is set' };
  }
  if (!TOKEN_RE.test(botToken)) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN format is invalid' };
  }
  if (!CHAT_ID_RE.test(chatId)) {
    return { ok: false, error: 'TELEGRAM_CHAT_ID format is invalid' };
  }
  return { ok: true, target: { botToken, chatId } };
}

/**
 * Whether a completed run should send a Telegram message for this source.
 *
 * Catch-up is silent when the run only skipped and has no `summary.reason` (already paid, `invoice_unreachable`, persisted failed — no spam on restart or 15-minute retry).
 *
 * @param source - Scheduler, catch-up, or CLI.
 * @param summary - Run outcome.
 * @returns Whether to call {@link notifyPayout}.
 */
export function shouldNotify(source: TelegramSource, summary: RunSummary): boolean {
  if (source === 'scheduler' || source === 'cli') {
    return true;
  }
  if (summary.reason !== undefined) {
    return true;
  }
  return (
    summary.paid.length +
      summary.failed.length +
      summary.uncertain.length +
      summary.dryRun.length >
    0
  );
}

/**
 * Dedupe key for scheduler/catch-up preflight notifies.
 * `null` means always send (CLI, or any paid/uncertain/dry-run line).
 * A non-empty `summary.reason` with empty paid/uncertain/dryRun is a preflight
 * key even when `failed` mirrors the reason (e.g. `usd_to_sats`).
 *
 * @param source - Scheduler, catch-up, or CLI.
 * @param summary - Run outcome.
 * @returns Key string, or `null` when the notify must not be deduped.
 */
export function telegramDedupeKey(source: TelegramSource, summary: RunSummary): string | null {
  if (source === 'cli') {
    return null;
  }
  if (summary.paid.length + summary.uncertain.length + summary.dryRun.length > 0) {
    return null;
  }
  if (typeof summary.reason === 'string' && summary.reason !== '') {
    return `${summary.day}|${summary.reason}`;
  }
  return null;
}

/** In-memory per-process log of already-sent preflight reasons. */
export class TelegramDedupe {
  private readonly seen = new Set<string>();

  /**
   * Whether this source/summary may still send a Telegram message.
   * Does not record the key — call {@link remember} only after a successful send.
   *
   * @param source - Scheduler, catch-up, or CLI.
   * @param summary - Run outcome.
   * @returns Whether to call {@link notifyPayout}.
   */
  allow(source: TelegramSource, summary: RunSummary): boolean {
    if (!shouldNotify(source, summary)) {
      return false;
    }
    const key = telegramDedupeKey(source, summary);
    if (key === null) {
      return true;
    }
    return !this.seen.has(key);
  }

  /**
   * Record a successfully sent preflight reason. No-op when the key is null.
   *
   * @param source - Scheduler, catch-up, or CLI.
   * @param summary - Run outcome that was sent.
   */
  remember(source: TelegramSource, summary: RunSummary): void {
    const key = telegramDedupeKey(source, summary);
    if (key === null) {
      return;
    }
    this.seen.add(key);
  }
}

function formatLine(line: PayoutLine): string {
  const parts: string[] = [displayLightningAddress(line.address)];
  if (line.amountSats !== undefined) {
    parts.push(`${line.amountSats} sats`);
  }
  if (line.amountUsd !== undefined) {
    parts.push(`($${line.amountUsd})`);
  }
  if (line.reason !== undefined) {
    parts.push(`(${line.reason})`);
  }
  return parts.join('  ');
}

const REASON_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  insufficient_balance: 'insufficient balance',
  locked: 'lock held',
  halted: 'halted',
  spot_unreadable: 'BTC-USD spot unreadable',
  usd_to_sats: 'USD to sats failed',
  balance_unreadable: 'wallet balance unreadable',
  lndhub_preflight: 'LNDHub preflight failed',
  bad_lndhub_uri: 'bad LNDHub URI',
  corrupt_state: 'corrupt payout state',
  corrupt_recipients: 'corrupt recipients file',
  invoice_unreachable: 'invoice create unreachable',
};

/**
 * Human-readable name for a payout `summary.reason` code.
 * Known codes use the map below; anything else is the code with `_` replaced by spaces.
 *
 * @param reason - Machine reason code from {@link RunSummary.reason}.
 * @returns Display name (never empty when `reason` is non-empty).
 */
export function reasonDisplayName(reason: string): string {
  if (reason === '') {
    return '';
  }
  return REASON_DISPLAY_NAMES[reason] ?? reason.replaceAll('_', ' ');
}

/**
 * Build a plain-text Telegram body (no parse_mode / HTML / Markdown).
 *
 * @param summary - Run outcome.
 * @param source - Who triggered the payout.
 * @returns Message text with LF newlines.
 */
export function formatPayoutMessage(summary: RunSummary, source: TelegramSource): string {
  const lines: string[] = [
    `21gifts spend ${summary.day} UTC`,
    `source=${source} live=${summary.live} ok=${summary.ok} exit=${summary.exitCode}`,
  ];
  if (summary.reason !== undefined) {
    let reasonLine = `reason=${summary.reason}`;
    if (summary.reason !== '') {
      reasonLine += ` (${reasonDisplayName(summary.reason)})`;
    }
    if (summary.needed !== undefined) {
      reasonLine += ` needed=${summary.needed}`;
    }
    if (summary.available !== undefined) {
      reasonLine += ` available=${summary.available}`;
    }
    lines.push(reasonLine);
  }
  if (summary.btcUsd !== undefined) {
    lines.push(`btcUsd=${summary.btcUsd}`);
  }
  lines.push(
    `paid ${summary.paid.length}  skipped ${summary.skipped.length}  failed ${summary.failed.length}  uncertain ${summary.uncertain.length}  dry-run ${summary.dryRun.length}`,
  );
  for (const line of summary.paid) {
    lines.push(formatLine(line));
  }
  for (const line of summary.dryRun) {
    lines.push(formatLine(line));
  }
  for (const line of summary.failed) {
    lines.push(formatLine(line));
  }
  for (const line of summary.uncertain) {
    lines.push(formatLine(line));
  }
  for (const line of summary.skipped) {
    lines.push(formatLine(line));
  }
  return lines.join('\n');
}

function redactToken(text: string, token: string): string {
  return text.split(token).join('[REDACTED]');
}

function logTelegram(fields: Record<string, string | number | boolean>): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'spend.telegram', ...fields }));
}

/**
 * POST a payout summary to Telegram. Never throws; never logs the bot token.
 *
 * @param opts - Target, summary, source, and optional fetch/timeout.
 * @returns `{ ok: true }` on HTTP 2xx, otherwise `{ ok: false }`.
 */
export async function notifyPayout(opts: {
  target: TelegramTarget;
  summary: RunSummary;
  source: TelegramSource;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const { target, summary, source } = opts;
  const text = formatPayoutMessage(summary, source);
  const url = `https://api.telegram.org/bot${target.botToken}/sendMessage`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    let reason: 'network' | 'timeout' = 'network';
    if (err instanceof Error) {
      const safe = redactToken(err.message, target.botToken);
      if (err.name === 'TimeoutError' || err.name === 'AbortError' || /aborted|timeout/i.test(safe)) {
        reason = 'timeout';
      }
    }
    logTelegram({ ok: false, source, day: summary.day, reason });
    return { ok: false };
  }

  if (response.status >= 200 && response.status < 300) {
    logTelegram({ ok: true, source, day: summary.day, http: response.status });
    return { ok: true };
  }
  logTelegram({ ok: false, source, day: summary.day, reason: 'http', http: response.status });
  return { ok: false };
}

/**
 * Build a minimal summary when an injected `runDay` only returns `{ exitCode }`.
 *
 * @param day - UTC day key.
 * @param live - Whether the run was live.
 * @param exitCode - Process exit code.
 * @returns Summary with empty recipient bags.
 */
export function minimalRunSummary(day: string, live: boolean, exitCode: number): RunSummary {
  return {
    day,
    live,
    ok: exitCode === 0,
    exitCode,
    paid: [],
    skipped: [],
    failed: [],
    uncertain: [],
    dryRun: [],
  };
}
