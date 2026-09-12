import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isUtcMidnightWindow, main, parseArgs } from '../cli';

const PREIMAGE = '11'.repeat(32);
const HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');
const TELEGRAM_TOKEN = '123456:AA-testtoken_notreal_xxxxxx';
const TELEGRAM_CHAT = '-1001234567890';

function cliEnv(dir: string, seed: string): Record<string, string> {
  return {
    GIFTS_API_URL: 'http://api.example',
    GIFTS_API_TOKEN: 'tok',
    LNDHUB_URI: 'lndhub://admin:secret@https://lightning.space/lndhub',
    RECIPIENTS_FILE: seed,
    STATE_DIR: dir,
  };
}

function seedRecipients(dir: string): string {
  const seed = join(dir, 'seed.json');
  writeFileSync(
    seed,
    `${JSON.stringify({
      comment: '21gifts daily',
      recipients: [{ address: 'a@b.com', amountUsd: 1 }],
    })}\n`,
  );
  return seed;
}

describe('parseArgs', () => {
  it('defaults to dry-run and today', () => {
    const flags = parseArgs(['bun', 'cli']);
    expect(flags.ok).toBe(true);
    if (flags.ok) {
      expect(flags.live).toBe(false);
      expect(flags.atUtcMidnight).toBe(false);
      expect(flags.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('reads --live, --date, and --at-utc-midnight', () => {
    expect(
      parseArgs(
        ['bun', 'cli', '--live', '--at-utc-midnight', '--date', '2026-08-23'],
        new Date('2026-08-25T00:00:00.000Z'),
      ),
    ).toEqual({
      ok: true,
      live: true,
      day: '2026-08-23',
      atUtcMidnight: true,
    });
  });

  it('defaults the day from the injected clock', () => {
    expect(parseArgs(['bun', 'cli'], new Date('2026-08-25T00:00:00.000Z'))).toEqual({
      ok: true,
      live: false,
      day: '2026-08-25',
      atUtcMidnight: false,
    });
  });

  it('rejects a missing or malformed --date', () => {
    expect(parseArgs(['bun', 'cli', '--date']).ok).toBe(false);
    expect(parseArgs(['bun', 'cli', '--date', '2026-8-23']).ok).toBe(false);
  });

  it('main prints the --date error', async () => {
    const code = await main({}, ['bun', 'cli', '--date']);
    expect(code).toBe(2);
  });
});

describe('isUtcMidnightWindow', () => {
  it('accepts the first minutes of UTC hour 0', () => {
    expect(isUtcMidnightWindow(new Date('2026-08-25T00:00:00.000Z'))).toBe(true);
    expect(isUtcMidnightWindow(new Date('2026-08-25T00:05:00.000Z'))).toBe(true);
  });

  it('rejects later UTC hours and minutes after 05', () => {
    expect(isUtcMidnightWindow(new Date('2026-08-25T00:06:00.000Z'))).toBe(false);
    expect(isUtcMidnightWindow(new Date('2026-08-24T22:00:00.000Z'))).toBe(false);
    expect(isUtcMidnightWindow(new Date('2026-08-25T02:00:00.000Z'))).toBe(false);
  });
});

describe('main --at-utc-midnight', () => {
  it('exits 0 outside the window without loading config', async () => {
    const code = await main({}, ['bun', 'cli', '--live', '--at-utc-midnight'], () =>
      new Date('2026-08-24T22:00:00.000Z'),
    );
    expect(code).toBe(0);
  });

  it('still loads config when --at-utc-midnight is omitted', async () => {
    const code = await main({}, ['bun', 'cli', '--live'], () =>
      new Date('2026-08-24T22:00:00.000Z'),
    );
    expect(code).toBe(2);
  });

  it('loads config after the window opens', async () => {
    const code = await main({}, ['bun', 'cli', '--live', '--at-utc-midnight'], () =>
      new Date('2026-08-25T00:00:00.000Z'),
    );
    expect(code).toBe(2);
  });
});

describe('main live recipients', () => {
  it('exits 4 when the live recipients file is corrupt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-cli-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    writeFileSync(join(dir, 'recipients.json'), '{');
    const code = await main(
      {
        GIFTS_API_URL: 'http://api.example',
        GIFTS_API_TOKEN: 'tok',
        LNDHUB_URI: 'lndhub://admin:secret@https://lightning.space/lndhub',
        RECIPIENTS_FILE: seed,
        STATE_DIR: dir,
      },
      ['bun', 'cli'],
      () => new Date('2026-08-25T12:00:00.000Z'),
    );
    expect(code).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });

  it('notifies Telegram and exits 4 when live recipients are corrupt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-cli-'));
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '{"comment":"x","recipients":[{"address":"a@b.com","amountUsd":1}]}\n');
    writeFileSync(join(dir, 'recipients.json'), '{');
    const telegramBodies: unknown[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main(
      {
        ...cliEnv(dir, seed),
        TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
        TELEGRAM_CHAT_ID: TELEGRAM_CHAT,
      },
      ['bun', 'cli'],
      () => new Date('2026-08-25T12:00:00.000Z'),
      async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    );
    error.mockRestore();
    expect(code).toBe(4);
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      chat_id: TELEGRAM_CHAT,
      text: expect.stringContaining('corrupt_recipients'),
      disable_web_page_preview: true,
    });
    expect(String((telegramBodies[0] as { text: string }).text)).toContain('source=cli');
    expect(JSON.stringify(telegramBodies)).not.toContain(TELEGRAM_TOKEN);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('main Telegram notify', () => {
  it('exits 2 when Telegram env is incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-cli-tg-'));
    const seed = seedRecipients(dir);
    const code = await main(
      { ...cliEnv(dir, seed), TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN },
      ['bun', 'cli'],
      () => new Date('2026-08-25T12:00:00.000Z'),
    );
    expect(code).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not call api.telegram.org when Telegram is unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-cli-tg-'));
    const seed = seedRecipients(dir);
    const urls: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const code = await main(
      cliEnv(dir, seed),
      ['bun', 'cli', '--date', '2026-08-25'],
      () => new Date('2026-08-25T12:00:00.000Z'),
      async (url) => {
        urls.push(String(url));
        if (String(url).includes('coinbase.com')) {
          return new Response(JSON.stringify({ data: { amount: '100000' } }), { status: 200 });
        }
        if (String(url).includes('/invoices/passkey')) {
          return new Response(JSON.stringify({ hasPasskey: true }), { status: 200 });
        }
        if (String(url).includes('/invoices/posted')) {
          return new Response(JSON.stringify({ hasPosted: true }), { status: 200 });
        }
        if (String(url).includes('/invoices') && !String(url).endsWith('/proof')) {
          return new Response(
            JSON.stringify({
              id: 'id1',
              pr: 'lnbc1',
              paymentHash: HASH,
              amountMsat: 1_000_000,
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 200 });
      },
    );
    warn.mockRestore();
    expect(code).toBe(0);
    expect(urls.some((u) => u.includes('api.telegram.org'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('notifies Telegram after a successful dry-run when configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-cli-tg-'));
    const seed = seedRecipients(dir);
    const telegramBodies: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const code = await main(
      {
        ...cliEnv(dir, seed),
        TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
        TELEGRAM_CHAT_ID: TELEGRAM_CHAT,
      },
      ['bun', 'cli', '--date', '2026-08-25'],
      () => new Date('2026-08-25T12:00:00.000Z'),
      async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        if (String(url).includes('coinbase.com')) {
          return new Response(JSON.stringify({ data: { amount: '100000' } }), { status: 200 });
        }
        if (String(url).includes('/invoices/passkey')) {
          return new Response(JSON.stringify({ hasPasskey: true }), { status: 200 });
        }
        if (String(url).includes('/invoices/posted')) {
          return new Response(JSON.stringify({ hasPosted: true }), { status: 200 });
        }
        if (String(url).includes('/invoices') && !String(url).endsWith('/proof')) {
          return new Response(
            JSON.stringify({
              id: 'id1',
              pr: 'lnbc1',
              paymentHash: HASH,
              amountMsat: 1_000_000,
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 200 });
      },
    );
    warn.mockRestore();
    expect(code).toBe(0);
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      chat_id: TELEGRAM_CHAT,
      text: expect.stringContaining('source=cli'),
      disable_web_page_preview: true,
    });
    expect(JSON.stringify(telegramBodies)).not.toContain(TELEGRAM_TOKEN);
    rmSync(dir, { recursive: true, force: true });
  });

  it('still notifies Telegram after a failed run and keeps the exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-cli-tg-'));
    const seed = seedRecipients(dir);
    const telegramBodies: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const code = await main(
      {
        ...cliEnv(dir, seed),
        TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
        TELEGRAM_CHAT_ID: TELEGRAM_CHAT,
      },
      ['bun', 'cli', '--date', '2026-08-25'],
      () => new Date('2026-08-25T12:00:00.000Z'),
      async (url, init) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response('{"ok":true}', { status: 200 });
        }
        if (String(url).includes('coinbase.com')) {
          return new Response('{}', { status: 500 });
        }
        return new Response('{}', { status: 200 });
      },
    );
    warn.mockRestore();
    expect(code).toBe(3);
    expect(telegramBodies).toHaveLength(1);
    expect(telegramBodies[0]).toMatchObject({
      text: expect.stringContaining('reason=spot_unreadable'),
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
