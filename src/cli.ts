import { loadConfig } from './config';
import { runDay } from './run';

/** First minutes of UTC hour 0 — cron may fire a bit after :00. */
const UTC_MIDNIGHT_MINUTE_LIMIT = 5;

/**
 * Whether `now` is in the UTC midnight window (hour 0, minute 0–5).
 *
 * macOS cron ignores `CRON_TZ`; schedule hourly and gate here.
 *
 * @param now - Instant to test.
 * @returns True only in that window.
 */
export function isUtcMidnightWindow(now: Date): boolean {
  return now.getUTCHours() === 0 && now.getUTCMinutes() <= UTC_MIDNIGHT_MINUTE_LIMIT;
}

/**
 * Parse argv for `--live`, `--date YYYY-MM-DD`, and `--at-utc-midnight`.
 *
 * @param argv - Process arguments including argv0.
 * @returns Flags.
 */
export function parseArgs(
  argv: string[],
):
  | { ok: true; live: boolean; day: string; atUtcMidnight: boolean }
  | { ok: false; error: string } {
  let live = false;
  let atUtcMidnight = false;
  let day = new Date().toISOString().slice(0, 10);
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
 * CLI entry. Loads env, runs one day, exits with the run code.
 *
 * @returns Promise of the exit code (tests); production calls `process.exit`.
 */
export async function main(
  env = process.env,
  argv = process.argv,
  now: () => Date = () => new Date(),
): Promise<number> {
  const loaded = loadConfig(env);
  if (!loaded.ok) {
    console.error(JSON.stringify({ event: 'spend.config', error: loaded.error }));
    return 2;
  }
  const flags = parseArgs(argv);
  if (!flags.ok) {
    console.error(JSON.stringify({ event: 'spend.config', error: flags.error }));
    return 2;
  }
  if (flags.atUtcMidnight) {
    const instant = now();
    if (!isUtcMidnightWindow(instant)) {
      console.warn(
        JSON.stringify({
          event: 'spend.skip_window',
          utcHour: instant.getUTCHours(),
          utcMinute: instant.getUTCMinutes(),
        }),
      );
      return 0;
    }
  }
  const result = await runDay(loaded.config, { live: flags.live, day: flags.day });
  return result.exitCode;
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  void main().then((code) => {
    process.exit(code);
  });
}
