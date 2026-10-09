import { loadConfig } from "./config";
import { GiftsApi, GiftsApiError, type RosterDocument } from "./gifts-api";
import { parseLightningAddress } from "./lightning-address";
import { LndhubClient, parseLndhubUri } from "./lndhub";
import { fetchBtcUsdSpot } from "./price";
import {
  CorruptRecipientsError,
  ensureLiveRecipients,
  loadLiveRecipients,
} from "./recipients-store";
import { runDay } from "./run";
import {
  loadTelegram,
  minimalRunSummary,
  notifyPayout,
  shouldNotify,
} from "./telegram";
import { isUtcMidnightWindow } from "./utc-window";

export { isUtcMidnightWindow } from "./utc-window";

/**
 * Parse argv for `--live`, `--date YYYY-MM-DD`, `--address`, and `--at-utc-midnight`.
 *
 * `--live` without `--address` is rejected so a one-shot cannot pay the whole roster.
 *
 * @param argv - Process arguments including argv0.
 * @param now - Instant used for the default UTC day (must match the window clock).
 * @returns Flags.
 */
export function parseArgs(
  argv: string[],
  now: Date = new Date(),
):
  | {
      ok: true;
      live: boolean;
      day: string;
      atUtcMidnight: boolean;
      onlyAddresses?: string[];
    }
  | { ok: false; error: string } {
  let live = false;
  let atUtcMidnight = false;
  let day = now.toISOString().slice(0, 10);
  const onlyAddresses: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--live") {
      live = true;
    }
    if (argv[i] === "--at-utc-midnight") {
      atUtcMidnight = true;
    }
    if (argv[i] === "--date") {
      const value = argv[i + 1];
      if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, error: "--date requires YYYY-MM-DD" };
      }
      day = value;
    }
    if (argv[i] === "--address") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: "--address requires a Lightning Address (name@domain)",
        };
      }
      const parsed = parseLightningAddress(value);
      if (parsed === null) {
        return {
          ok: false,
          error: "--address requires a Lightning Address (name@domain)",
        };
      }
      onlyAddresses.push(parsed);
    }
  }
  if (live && onlyAddresses.length === 0) {
    return {
      ok: false,
      error:
        "--live requires --address so a one-shot cannot pay the whole roster",
    };
  }
  return {
    ok: true,
    live,
    day,
    atUtcMidnight,
    ...(onlyAddresses.length > 0 ? { onlyAddresses } : {}),
  };
}

/**
 * CLI entry. Optionally no-ops outside UTC midnight, then loads env, imports
 * the live file as a one-time roster payload, and asks the API for a daily
 * instruction per address. Signs only `action: pay`. Does not read
 * `paymentsEnabled`, roster `amountUsd`, or the file comment to decide.
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
    console.error(
      JSON.stringify({ event: "spend.config", error: flags.error }),
    );
    return 2;
  }
  if (flags.atUtcMidnight && !isUtcMidnightWindow(instant)) {
    console.warn(
      JSON.stringify({
        ts: instant.toISOString(),
        event: "spend.skip_window",
        utcHour: instant.getUTCHours(),
        utcMinute: instant.getUTCMinutes(),
      }),
    );
    return 0;
  }
  const loaded = loadConfig(env);
  if (!loaded.ok) {
    console.error(
      JSON.stringify({ event: "spend.config", error: loaded.error }),
    );
    return 2;
  }
  const telegram = loadTelegram(env);
  if (!telegram.ok) {
    console.error(
      JSON.stringify({ event: "spend.config", error: telegram.error }),
    );
    return 2;
  }
  try {
    ensureLiveRecipients(loaded.config.stateDir, loaded.config.recipientsFile);
    const liveList = loadLiveRecipients(loaded.config.stateDir);
    const gifts = new GiftsApi(
      loaded.config.giftsApiUrl,
      loaded.config.giftsApiToken,
      fetchImpl,
    );
    let imported: RosterDocument;
    try {
      imported = await gifts.importRosterDocument({
        comment: liveList.comment,
        paymentsEnabled: liveList.paymentsEnabled,
        moderatorPaymentsEnabled: liveList.moderatorPaymentsEnabled,
        recipients: liveList.recipients.map((recipient) => ({
          address: recipient.address,
          amountUsd: recipient.amountUsd,
        })),
        moderators: liveList.moderators.map((moderator) => ({
          address: moderator.address,
          amountUsd: moderator.amountUsd,
        })),
      });
    } catch (err) {
      if (
        err instanceof GiftsApiError &&
        (err.status === 401 || err.status === 400)
      ) {
        console.error(
          JSON.stringify({ event: "spend.config", error: err.message }),
        );
        return 2;
      }
      console.warn(
        JSON.stringify({
          ts: instant.toISOString(),
          event: "spend.done",
          ok: false,
          reason: "instruction_unreachable",
        }),
      );
      return 3;
    }
    const addresses =
      flags.onlyAddresses !== undefined
        ? flags.onlyAddresses
        : imported.recipients.map((recipient) => recipient.address);
    if (addresses.length === 0) {
      return 0;
    }
    const skipped: Array<{ address: string; reason: string }> = [];
    const payRecipients: Array<{
      address: string;
      amountUsd: number;
      comment: string;
    }> = [];
    const messageIdByAddress: Record<string, string> = {};
    for (const address of addresses) {
      let instruction;
      try {
        instruction = await gifts.dailyInstruction(address);
      } catch (err) {
        if (
          err instanceof GiftsApiError &&
          (err.status === 401 || err.status === 400)
        ) {
          console.error(
            JSON.stringify({ event: "spend.config", error: err.message }),
          );
          return 2;
        }
        console.warn(
          JSON.stringify({
            ts: instant.toISOString(),
            event: "spend.done",
            ok: false,
            reason: "instruction_unreachable",
          }),
        );
        return 3;
      }
      if (instruction.action === "skip") {
        skipped.push({ address, reason: instruction.reason });
        continue;
      }
      payRecipients.push({
        address,
        amountUsd: instruction.amountUsd,
        comment: instruction.comment,
      });
      if (instruction.messageId !== undefined) {
        messageIdByAddress[address.toLowerCase()] = instruction.messageId;
      }
    }
    if (payRecipients.length === 0) {
      for (const row of skipped) {
        console.warn(
          JSON.stringify({
            ts: instant.toISOString(),
            event: "spend.skip",
            address: row.address,
            reason: row.reason,
          }),
        );
      }
      return 0;
    }
    const lndhubTarget = parseLndhubUri(loaded.config.lndhubUri);
    const result = await runDay(
      { ...loaded.config, recipients: payRecipients },
      {
        live: flags.live,
        day: flags.day,
        onlyAddresses: payRecipients.map((recipient) => recipient.address),
        ...(Object.keys(messageIdByAddress).length > 0
          ? { messageIdByAddress }
          : {}),
      },
      lndhubTarget === null
        ? undefined
        : {
            gifts,
            lndhub: new LndhubClient(lndhubTarget, fetchImpl),
            btcUsd: () => fetchBtcUsdSpot(fetchImpl),
          },
    );
    if (telegram.target !== null && shouldNotify("cli", result.summary)) {
      await notifyPayout({
        target: telegram.target,
        summary: result.summary,
        source: "cli",
        fetchImpl,
      });
    }
    return result.exitCode;
  } catch (err) {
    if (err instanceof CorruptRecipientsError) {
      console.error(
        JSON.stringify({
          event: "spend.done",
          ok: false,
          reason: "corrupt_recipients",
        }),
      );
      const summary = {
        ...minimalRunSummary(flags.day, flags.live, 4),
        reason: "corrupt_recipients",
      };
      if (telegram.target !== null && shouldNotify("cli", summary)) {
        await notifyPayout({
          target: telegram.target,
          summary,
          source: "cli",
          fetchImpl,
        });
      }
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
