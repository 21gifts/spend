import { loadConfig } from './config';
import { GiftsApi } from './gifts-api';
import { LndhubClient, parseLndhubUri } from './lndhub';
import { fetchBtcUsdSpot } from './price';
import {
  CorruptRecipientsError,
  ensureLiveRecipients,
  loadLiveRecipients,
} from './recipients-store';
import { runDay } from './run';
import { loadTelegram, notifyPayout, shouldNotify } from './telegram';
import { isUtcMidnightWindow } from './utc-window';

export { isUtcMidnightWindow } from './utc-window';

/**
 * Parse argv for `--live`, `--date YYYY-MM-DD`, and `--at-utc-midnight`.
 *
 * @param argv - Process arguments including argv0.
 * @param now - Instant used for the default UTC day (must match the window clock).
 * @returns Flags.
 */
export function parseArgs(
  argv: string[],
  now: Date = new Date(),
):
  | { ok: true; live: boolean; day: string; atUtcMidnight: boolean }
  | { ok: false; error: string } {
  let live = false;
  let atUtcMidnight = false;
  let day = now.toISOString().slice(0, 10);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--live') {
      live = true;
    }
    if (argv[i] === '--at-utc-midnight') {
      atUtcMidnight = true;
    }
    if (argv[i] === '--date') {
      const value = argv[i + 1];
      if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, error: '--date requires YYYY-MM-DD' };
      }
      day = value;
    }
  }
  return { ok: true, live, day, atUtcMidnight };
}

/**
 * CLI entry. Optionally no-ops outside UTC midnight, then loads env and runs one day.
 *
 * @param env - Process env.
 * @param argv - Process arguments.
 * @param now - Clock (default: `Date`).
 * @param fetchImpl - HTTP fetch for payout clients and Telegram notify (default: `fetch`).
 * @returns Promise of the exit code (tests); production calls `process.exit`.
 */
export async function main(
  env = process.env,
  argv = process.argv,
  now: () => Date = () => new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const instant = now();
  const flags = parseArgs(argv, instant);
  if (!flags.ok) {
    console.error(JSON.stringify({ event: 'spend.config', error: flags.error }));
    return 2;
  }
  if (flags.atUtcMidnight && !isUtcMidnightWindow(instant)) {
    console.warn(
      JSON.stringify({
        ts: instant.toISOString(),
        event: 'spend.skip_window',
        utcHour: instant.getUTCHours(),
        utcMinute: instant.getUTCMinutes(),
      }),
    );
    return 0;
  }
  const loaded = loadConfig(env);
  if (!loaded.ok) {
    console.error(JSON.stringify({ event: 'spend.config', error: loaded.error }));
    return 2;
  }
  const telegram = loadTelegram(env);
  if (!telegram.ok) {
    console.error(JSON.stringify({ event: 'spend.config', error: telegram.error }));
    return 2;
  }
  try {
    ensureLiveRecipients(loaded.config.stateDir, loaded.config.recipientsFile);
    const liveList = loadLiveRecipients(loaded.config.stateDir);
    const lndhubTarget = parseLndhubUri(loaded.config.lndhubUri);
    const result = await runDay(
      { ...loaded.config, recipients: liveList.recipients, comment: liveList.comment },
      { live: flags.live, day: flags.day },
      lndhubTarget === null
        ? undefined
        : {
            gifts: new GiftsApi(loaded.config.giftsApiUrl, loaded.config.giftsApiToken, fetchImpl),
            lndhub: new LndhubClient(lndhubTarget, fetchImpl),
            btcUsd: () => fetchBtcUsdSpot(fetchImpl),
          },
    );
    if (telegram.target !== null && shouldNotify('cli', result.summary)) {
      await notifyPayout({
        target: telegram.target,
        summary: result.summary,
        source: 'cli',
        fetchImpl,
      });
    }
    return result.exitCode;
  } catch (err) {
    if (err instanceof CorruptRecipientsError) {
      console.error(
        JSON.stringify({ event: 'spend.done', ok: false, reason: 'corrupt_recipients' }),
      );
      return 4;
    }
    throw err;
  }
}

/* v8 ignore start */
const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  void main().then((code) => {
    process.exit(code);
  });
}
/* v8 ignore stop */
