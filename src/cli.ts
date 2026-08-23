import { loadConfig } from './config';
import { runDay } from './run';

/**
 * Parse argv for `--live` and `--date YYYY-MM-DD`.
 *
 * @param argv - Process arguments including argv0.
 * @returns Flags.
 */
export function parseArgs(
  argv: string[],
): { ok: true; live: boolean; day: string } | { ok: false; error: string } {
  let live = false;
  let day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--live') {
      live = true;
    }
    if (argv[i] === '--date') {
      const value = argv[i + 1];
      if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, error: '--date requires YYYY-MM-DD' };
      }
      day = value;
    }
  }
  return { ok: true, live, day };
}

/**
 * CLI entry. Loads env, runs one day, exits with the run code.
 *
 * @returns Promise of the exit code (tests); production calls `process.exit`.
 */
export async function main(env = process.env, argv = process.argv): Promise<number> {
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
  const result = await runDay(loaded.config, { live: flags.live, day: flags.day });
  return result.exitCode;
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  void main().then((code) => {
    process.exit(code);
  });
}
