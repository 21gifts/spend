import { loadConfig } from './config';
import { runDay } from './run';
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
 * @returns Promise of the exit code (tests); production calls `process.exit`.
 */
export async function main(
  env = process.env,
  argv = process.argv,
  now: () => Date = () => new Date(),
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
  const result = await runDay(loaded.config, { live: flags.live, day: flags.day });
  return result.exitCode;
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  void main().then((code) => {
    process.exit(code);
  });
}
