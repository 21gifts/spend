# 21gifts/spend

Daily Lightning gift payouts. This process **does not generate invoices**.

1. `POST {GIFTS_API_URL}/invoices` — 21.gifts api fetches the recipient BOLT11
2. LNDHub `payinvoice` on lightning.space
3. `POST {GIFTS_API_URL}/invoices/proof` with the **preimage** (`sha256` = payment hash)

Default is dry-run: fetch invoices from the API and log them, **no LNDHub
auth and no pay**. `--live` authenticates to lightning.space, checks balance,
then pays.

## Setup

```bash
cp .env.example .env
cp recipients.example.json recipients.json
# fill GIFTS_API_TOKEN and LNDHUB_URI (lndhub://admin:<key>@https://lightning.space/lndhub)
bun install
bun src/cli.ts            # dry-run
bun src/cli.ts --date 2026-08-23  # dry-run for that UTC state day
bun src/cli.ts --live     # real payments
```

Cron (UTC midnight). macOS cron ignores `CRON_TZ`, so do **not** use `0 0 * * *`
with `CRON_TZ=UTC` — that fires at local midnight. Run hourly at local minute 0
on a host whose UTC offset is a whole number of hours (e.g. Europe/Zurich:
02:00 CEST = 00:00 UTC) and let the process no-op unless it is UTC hour 0:

```
0 * * * * cd /path/to/spend && set -a && . ./.env && set +a && bun src/cli.ts --live --at-utc-midnight
```

The shell still sources `.env` (fail-closed if it is missing). Inside the
process, `--at-utc-midnight` checks the UTC window **before** validating
config / reading the recipients file: it exits `0` without paying unless UTC
hour is 0 and the minute is 0–5. Same-day re-entry is still gated by JSONL
(`paid` / `uncertain`). The default state day is the UTC day of that same
clock sample (override with `--date`).

## Fail-closed

- Balance preflight before the first pay (need remaining amount + `max(100 sats, 1%)` fee margin). LNDHub `balance` is sats as returned — not divided by 1000
- Every run takes an exclusive `STATE_DIR/YYYY-MM-DD.lock` (`O_EXCL`) for the process lifetime. A concurrent second run (live or dry-run) exits `3`. After a normal exit the lock file is removed; same-UTC-day re-entry is gated by JSONL (`paid` / `uncertain` / `*halt*`, not later `dry-run` rows)
- `uncertain` (network/5xx, missing preimage, proof failure, amount mismatch) is logged and **not** retried the same UTC day
- After `uncertain`, later recipients in a `--live` run are skipped and a `*halt*` JSONL row is appended so later runs that UTC day exit `4` without paying
- If a live process crashes, the lock file remains. Remove it only after checking that no spend is running and inspecting `STATE_DIR/YYYY-MM-DD.jsonl`
- Unreadable JSONL (truncated/corrupt line) aborts with exit `4` (`corrupt_state`) so a damaged `paid`/`uncertain` row cannot be ignored
- State: `STATE_DIR/YYYY-MM-DD.jsonl`

Exit codes: `0` ok, `2` config, `3` preflight/balance/lock, `4` failed, uncertain, or halted.

Secrets stay in `.env` / the LNDHub URI. They are never logged.
