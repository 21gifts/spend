import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatPayoutMessage,
  loadTelegram,
  minimalRunSummary,
  notifyPayout,
  reasonDisplayName,
  shouldNotify,
  telegramDedupeKey,
  TelegramDedupe,
  type RunSummary,
  type TelegramTarget,
} from '../telegram';

const TOKEN = '123456:AA-testtoken_notreal_xxxxxx';
const CHAT_ID = '-1001234567890';

const target: TelegramTarget = { botToken: TOKEN, chatId: CHAT_ID };

function baseSummary(extra: Partial<RunSummary> = {}): RunSummary {
  return {
    day: '2026-08-28',
    live: true,
    ok: true,
    exitCode: 0,
    paid: [],
    skipped: [],
    failed: [],
    uncertain: [],
    dryRun: [],
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadTelegram', () => {
  it('disables notify when both env vars are empty', () => {
    expect(loadTelegram({})).toEqual({ ok: true, target: null });
    expect(loadTelegram({ TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: '' })).toEqual({
      ok: true,
      target: null,
    });
  });

  it('fails closed when only one env var is set', () => {
    expect(loadTelegram({ TELEGRAM_BOT_TOKEN: TOKEN })).toEqual({
      ok: false,
      error: 'TELEGRAM_CHAT_ID is required when TELEGRAM_BOT_TOKEN is set',
    });
    expect(loadTelegram({ TELEGRAM_CHAT_ID: CHAT_ID })).toEqual({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN is required when TELEGRAM_CHAT_ID is set',
    });
  });

  it('rejects a bad bot token', () => {
    expect(
      loadTelegram({ TELEGRAM_BOT_TOKEN: 'not-a-token', TELEGRAM_CHAT_ID: CHAT_ID }),
    ).toEqual({ ok: false, error: 'TELEGRAM_BOT_TOKEN format is invalid' });
  });

  it('rejects a bad chat id', () => {
    expect(
      loadTelegram({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: 'room-name' }),
    ).toEqual({ ok: false, error: 'TELEGRAM_CHAT_ID format is invalid' });
  });

  it('returns a target when both are valid', () => {
    expect(loadTelegram({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID })).toEqual({
      ok: true,
      target,
    });
  });
});

describe('shouldNotify', () => {
  it('is always true for scheduler and cli', () => {
    const allSkip = baseSummary({
      skipped: [{ address: 'a@b.com', reason: 'paid' }],
    });
    expect(shouldNotify('scheduler', allSkip)).toBe(true);
    expect(shouldNotify('cli', allSkip)).toBe(true);
  });

  it('is false for catch-up when the run only skipped', () => {
    const allSkip = baseSummary({
      skipped: [{ address: 'a@b.com', reason: 'paid' }],
    });
    expect(shouldNotify('catchup', allSkip)).toBe(false);
  });

  it('is true for catch-up on reason or any paid/failed/uncertain/dry-run', () => {
    expect(shouldNotify('catchup', baseSummary({ reason: 'locked' }))).toBe(true);
    expect(
      shouldNotify('catchup', baseSummary({ paid: [{ address: 'a@b.com', amountSats: 1 }] })),
    ).toBe(true);
    expect(
      shouldNotify('catchup', baseSummary({ failed: [{ address: 'a@b.com' }] })),
    ).toBe(true);
    expect(
      shouldNotify('catchup', baseSummary({ uncertain: [{ address: 'a@b.com' }] })),
    ).toBe(true);
    expect(
      shouldNotify('catchup', baseSummary({ dryRun: [{ address: 'a@b.com' }] })),
    ).toBe(true);
  });
});

describe('formatPayoutMessage', () => {
  it('formats a paid run', () => {
    const text = formatPayoutMessage(
      baseSummary({
        btcUsd: 100_000,
        paid: [{ address: 'alice@x', amountSats: 1000, amountUsd: 1 }],
      }),
      'scheduler',
    );
    expect(text).toBe(
      [
        '21gifts spend 2026-08-28 UTC',
        'source=scheduler live=true ok=true exit=0',
        'btcUsd=100000',
        'paid 1  skipped 0  failed 0  uncertain 0  dry-run 0',
        'alice@x  1000 sats  ($1)',
      ].join('\n'),
    );
  });

  it('formats reason with needed and available', () => {
    const text = formatPayoutMessage(
      baseSummary({
        ok: false,
        exitCode: 3,
        reason: 'insufficient_balance',
        needed: 1500,
        available: 10,
        skipped: [{ address: 'alice@x', amountSats: 1000, amountUsd: 1, reason: 'already_paid' }],
      }),
      'cli',
    );
    expect(text).toContain('source=cli live=true ok=false exit=3');
    expect(text).toContain(
      'reason=insufficient_balance (insufficient balance) needed=1500 available=10',
    );
    expect(text).toContain('alice@x  1000 sats  ($1)  (already_paid)');
  });

  it('formats locked reason with display name and no needed/available', () => {
    const text = formatPayoutMessage(baseSummary({ reason: 'locked' }), 'scheduler');
    expect(text).toContain('reason=locked (lock held)');
    expect(text).not.toContain('needed=');
    expect(text).not.toContain('available=');
  });

  it('formats an empty reason without a display-name parenthesis', () => {
    const text = formatPayoutMessage(baseSummary({ reason: '' }), 'scheduler');
    expect(text).toContain('reason=');
    expect(text).not.toMatch(/reason= \(/);
  });

  it('abbreviates Wallet of Satoshi on a paid line', () => {
    const text = formatPayoutMessage(
      baseSummary({
        paid: [{ address: 'alice@walletofsatoshi.com', amountSats: 1000, amountUsd: 1 }],
      }),
      'scheduler',
    );
    expect(text).toContain('alice@w...  1000 sats  ($1)');
    expect(text.toLowerCase()).not.toContain('walletofsatoshi.com');
  });

  it('preserves local-part case for Wallet of Satoshi', () => {
    const text = formatPayoutMessage(
      baseSummary({
        paid: [{ address: 'Alice@WalletOfSatoshi.COM', amountSats: 1000, amountUsd: 1 }],
      }),
      'scheduler',
    );
    expect(text).toContain('Alice@w...');
    expect(text.toLowerCase()).not.toContain('walletofsatoshi.com');
  });

  it('leaves non-Wallet-of-Satoshi addresses full', () => {
    const text = formatPayoutMessage(
      baseSummary({
        paid: [{ address: '9643e3@lightning.space', amountSats: 500, amountUsd: 0.5 }],
      }),
      'scheduler',
    );
    expect(text).toContain('9643e3@lightning.space  500 sats  ($0.5)');
  });

  it('does not abbreviate a Wallet of Satoshi suffix trap', () => {
    const text = formatPayoutMessage(
      baseSummary({
        paid: [{ address: 'user@walletofsatoshi.com.evil', amountSats: 100, amountUsd: 0.1 }],
      }),
      'scheduler',
    );
    expect(text).toContain('user@walletofsatoshi.com.evil  100 sats  ($0.1)');
  });

  it('abbreviates Wallet of Satoshi on skipped lines', () => {
    const text = formatPayoutMessage(
      baseSummary({
        skipped: [
          {
            address: 'alice@walletofsatoshi.com',
            amountSats: 1000,
            amountUsd: 1,
            reason: 'already_paid',
          },
        ],
      }),
      'cli',
    );
    expect(text).toContain('alice@w...  1000 sats  ($1)  (already_paid)');
    expect(text.toLowerCase()).not.toContain('walletofsatoshi.com');
  });
});

describe('notifyPayout', () => {
  it('POSTs sendMessage without parse_mode and returns ok on 2xx', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let seenUrl = '';
    let seenBody: unknown;
    const result = await notifyPayout({
      target,
      summary: baseSummary(),
      source: 'scheduler',
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    expect(result).toEqual({ ok: true });
    expect(seenUrl).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(seenBody).toEqual({
      chat_id: CHAT_ID,
      text: expect.stringContaining('21gifts spend 2026-08-28 UTC'),
      disable_web_page_preview: true,
    });
    expect(seenBody).not.toHaveProperty('parse_mode');
    expect(JSON.stringify(warn.mock.calls)).toContain('spend.telegram');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('returns ok false on HTTP 400', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await notifyPayout({
      target,
      summary: baseSummary(),
      source: 'cli',
      fetchImpl: async () => new Response('bad', { status: 400 }),
    });
    expect(result).toEqual({ ok: false });
    const logged = String(warn.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('"reason":"http"');
    expect(logged).not.toContain(TOKEN);
  });

  it('returns ok false on network errors without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await notifyPayout({
      target,
      summary: baseSummary(),
      source: 'cli',
      fetchImpl: async () => {
        throw new Error(`network down ${TOKEN}`);
      },
    });
    expect(result).toEqual({ ok: false });
    const logged = String(warn.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('"reason":"network"');
    expect(logged).not.toContain(TOKEN);
  });

  it('returns ok false on timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await notifyPayout({
      target,
      summary: baseSummary(),
      source: 'catchup',
      fetchImpl: async () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    expect(result).toEqual({ ok: false });
    const logged = String(warn.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('"reason":"timeout"');
    expect(logged).not.toContain(TOKEN);
  });
});

describe('reasonDisplayName', () => {
  it('maps every known payout reason code', () => {
    expect(reasonDisplayName('insufficient_balance')).toBe('insufficient balance');
    expect(reasonDisplayName('locked')).toBe('lock held');
    expect(reasonDisplayName('halted')).toBe('halted');
    expect(reasonDisplayName('spot_unreadable')).toBe('BTC-USD spot unreadable');
    expect(reasonDisplayName('usd_to_sats')).toBe('USD to sats failed');
    expect(reasonDisplayName('balance_unreadable')).toBe('wallet balance unreadable');
    expect(reasonDisplayName('lndhub_preflight')).toBe('LNDHub preflight failed');
    expect(reasonDisplayName('bad_lndhub_uri')).toBe('bad LNDHub URI');
    expect(reasonDisplayName('corrupt_state')).toBe('corrupt payout state');
    expect(reasonDisplayName('corrupt_recipients')).toBe('corrupt recipients file');
    expect(reasonDisplayName('invoice_unreachable')).toBe('invoice create unreachable');
  });

  it('replaces underscores for unknown codes', () => {
    expect(reasonDisplayName('foo_bar')).toBe('foo bar');
  });

  it('returns empty string for empty input', () => {
    expect(reasonDisplayName('')).toBe('');
  });
});

describe('minimalRunSummary', () => {
  it('builds empty bags from an exit code', () => {
    expect(minimalRunSummary('2026-08-28', false, 0)).toEqual({
      day: '2026-08-28',
      live: false,
      ok: true,
      exitCode: 0,
      paid: [],
      skipped: [],
      failed: [],
      uncertain: [],
      dryRun: [],
    });
  });
});

describe('telegramDedupeKey', () => {
  it('is null for cli', () => {
    expect(
      telegramDedupeKey('cli', baseSummary({ reason: 'insufficient_balance' })),
    ).toBeNull();
  });

  it('is null when there is paid activity', () => {
    expect(
      telegramDedupeKey(
        'catchup',
        baseSummary({
          reason: 'insufficient_balance',
          paid: [{ address: 'a@b.com', amountSats: 1 }],
        }),
      ),
    ).toBeNull();
  });

  it('is null when reason is missing', () => {
    expect(telegramDedupeKey('scheduler', baseSummary())).toBeNull();
    expect(telegramDedupeKey('catchup', baseSummary({ reason: '' }))).toBeNull();
  });

  it('is null for failed-only without a reason', () => {
    expect(
      telegramDedupeKey('catchup', baseSummary({ failed: [{ address: 'a@b.com' }] })),
    ).toBeNull();
  });

  it('is day|reason for catchup and scheduler with empty bags', () => {
    const summary = baseSummary({ reason: 'insufficient_balance' });
    expect(telegramDedupeKey('catchup', summary)).toBe('2026-08-28|insufficient_balance');
    expect(telegramDedupeKey('scheduler', summary)).toBe('2026-08-28|insufficient_balance');
  });

  it('is day|reason for usd_to_sats even when failed mirrors the preflight', () => {
    expect(
      telegramDedupeKey(
        'catchup',
        baseSummary({ reason: 'usd_to_sats', failed: [{ address: 'a@b.com' }] }),
      ),
    ).toBe('2026-08-28|usd_to_sats');
  });

  it('ignores needed and available for the key', () => {
    expect(
      telegramDedupeKey(
        'catchup',
        baseSummary({ reason: 'insufficient_balance', needed: 1500, available: 10 }),
      ),
    ).toBe('2026-08-28|insufficient_balance');
    expect(
      telegramDedupeKey(
        'scheduler',
        baseSummary({ reason: 'insufficient_balance', needed: 9999, available: 1, btcUsd: 100_000 }),
      ),
    ).toBe('2026-08-28|insufficient_balance');
  });
});

describe('TelegramDedupe', () => {
  it('allows the same key until remember, then blocks it', () => {
    const log = new TelegramDedupe();
    const summary = baseSummary({ reason: 'insufficient_balance', needed: 100, available: 1 });
    expect(log.allow('catchup', summary)).toBe(true);
    expect(log.allow('catchup', summary)).toBe(true);
    log.remember('catchup', summary);
    expect(log.allow('catchup', summary)).toBe(false);
    expect(log.allow('scheduler', summary)).toBe(false);
  });

  it('keeps allow true when remember is skipped after a failed send', () => {
    const log = new TelegramDedupe();
    const summary = baseSummary({ reason: 'insufficient_balance' });
    expect(log.allow('scheduler', summary)).toBe(true);
    // failed notifyPayout → no remember
    expect(log.allow('scheduler', summary)).toBe(true);
  });

  it('still allows a later paid summary after remembering insufficient_balance', () => {
    const log = new TelegramDedupe();
    const preflight = baseSummary({ reason: 'insufficient_balance' });
    log.remember('catchup', preflight);
    expect(log.allow('catchup', preflight)).toBe(false);
    expect(
      log.allow(
        'catchup',
        baseSummary({ paid: [{ address: 'a@b.com', amountSats: 1 }] }),
      ),
    ).toBe(true);
  });
});
