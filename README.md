# 21gifts/spend

Daily Lightning gift payouts plus a tiny HTTP dashboard. This process **does not generate invoices**.

1. `POST {GIFTS_API_URL}/invoices` — 21.gifts api fetches the recipient BOLT11
2. LNDHub `payinvoice` on lightning.space
3. `POST {GIFTS_API_URL}/invoices/proof` with the **preimage** (`sha256` = payment hash)

Recipient amounts are **USD**. Each payout (midnight, catch-up, CLI) reads the live roster `STATE_DIR/recipients.json`, fetches Coinbase BTC-USD spot, and pays `round(usd / btcUsd * 1e8)` sats. Missing or unusable spot, or a conversion under 1 sat, is fail-closed (exit `3`). The optional `amountSats` field in a seed JSON is a snapshot only — the process does not read it.

The long-running server (`bun src/server.ts`) serves the dashboard and runs the UTC-midnight payout in-process. `SPEND_LIVE=true` pays; otherwise the scheduler is dry-run. On live boot it also runs a same-UTC-day catch-up (`spend.catchup`): already-`paid` JSONL rows are skipped, so a recipient added after midnight can still be paid on the next process start.

The dashboard at `GET /` shows:

- current LNDHub balance in sats
- the same balance in USD (Coinbase BTC-USD spot)
- the configured **Lightning Address** (`SPEND_LIGHTNING_ADDRESS`) and a `lightning:` QR

`GET /healthz` is the liveness probe (`HEAD /` and `HEAD /healthz` return 200 with an empty body). The public page does not link to the editor.

The recipient editor is at `GET /login` (password) then `GET /recipients`. Set `SPEND_DASHBOARD_PASSWORD`. When it is unset or blank, `/login` and `/recipients` return 503 and payouts still run. Session cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, 12h; `Secure` when the request is HTTPS or `X-Forwarded-Proto: https`. Mutations are POST-only (`/recipients/add`, `/recipients/update`, `/recipients/delete`, `/logout`).

Wallet of Satoshi addresses render as `local@w...` in the editor; mutations still use the full address. Visual snapshots (`bun run e2e:visual`) are Linux/Chromium; when login or editor layout changes, replace `e2e/visual.spec.ts-snapshots/` from the CI actuals.

Live roster: `STATE_DIR/recipients.json`. On first boot the seed at `RECIPIENTS_FILE` (process default `./recipients.json`; image `ENV` `/app/recipients.tondo.json`) is copied there if missing and is never overwritten afterwards. Midnight, catch-up, and the CLI reload that live file each run. An empty list after deletes pays nothing. `POST /login`, `POST /logout`, and list mutations require a same-origin `Origin` header (host must match `Host`).

## Setup

```bash
cp .env.example .env
cp recipients.example.json recipients.json
# fill GIFTS_API_TOKEN and LNDHUB_URI (lndhub://admin:<key>@https://lightning.space/lndhub)
bun install
bun src/server.ts         # dashboard + in-process UTC midnight scheduler
bun src/cli.ts            # one-shot dry-run
bun src/cli.ts --date 2026-08-23  # dry-run for that UTC state day
bun src/cli.ts --live     # one-shot real payments
```

Production image: `21gifts/spend:latest` (`linux/arm64`). `BIND_ADDR` defaults to `0.0.0.0:3000`. Recipients in the image are `recipients.tondo.json`. State is `STATE_DIR` (Docker: `/data`). Required env: `GIFTS_API_URL`, `GIFTS_API_TOKEN`, `LNDHUB_URI`. Optional: `SPEND_LIGHTNING_ADDRESS` (dashboard QR), `SPEND_DASHBOARD_PASSWORD` (recipient editor), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (plain-text payout notify — set **both** or **neither**; one alone or a bad format fails boot/CLI with exit `2`). Set `SPEND_LIVE=true` to pay.

After each daily payout (UTC midnight scheduler, live catch-up, or CLI), when Telegram is configured the process POSTs a plain-text summary to the chat. Telegram send failures never change the payout exit code. Catch-up skips notify when the run only skipped already-paid recipients (no spam on every container restart).

```bash
docker run -p 3000:3000 -v spend-state:/data \
  -e GIFTS_API_URL=https://api.21.gifts \
  -e GIFTS_API_TOKEN \
  -e LNDHUB_URI \
  -e SPEND_LIVE=true \
  -e SPEND_LIGHTNING_ADDRESS=user@domain \
  21gifts/spend:latest
```

UTC midnight: the server samples the clock every 30s. It calls the existing payout only when UTC hour is 0 and the minute is 0–5. Exit `3` (lock/balance/spot) is retried on the next tick inside that window; exit `0`, `2`, or `4` ends the UTC day for this process. Same-day re-entry is gated by JSONL (`paid` / `uncertain` / `*halt*`) and `STATE_DIR/YYYY-MM-DD.finished` (the marker survives restart, so midnight will not re-enter; live catch-up still pays newly added recipients). One-shot CLI still supports `--at-utc-midnight` for the same window.

## Fail-closed

- One payout at a time in-process (midnight tick and catch-up share a queue). SIGTERM waits for the in-flight run (55s cap)
- `POST /invoices` 409 (`Already paid today`) is treated as already paid — no second Lightning pay
- JSONL appends are `fsync`'d so a restart does not lose a just-written `paid` row
- Coinbase BTC-USD spot is required before any invoice. Recipients are USD; sats are computed at that spot
- Balance preflight before the first pay (need remaining amount + `max(100 sats, 1%)` fee margin). LNDHub `balance` is sats as returned — not divided by 1000
- Every run takes an exclusive `STATE_DIR/YYYY-MM-DD.lock` (`O_EXCL`) for the process lifetime. A concurrent second run exits `3`. After a normal exit the lock file is removed only if it still holds this process's token. A leftover lock is stolen when its owner pid is dead, when the pid is this process but the lock was written before this process started (container PID reuse), or when the file has no pid and is older than 10 minutes. Same-UTC-day re-entry is gated by JSONL (`paid` / `uncertain` / `*halt*`) and `YYYY-MM-DD.finished` (survives restart — midnight will not re-enter; catch-up still pays newly added recipients)
- `uncertain` (network/5xx, missing preimage, proof failure, amount mismatch) is logged and **not** retried the same UTC day
- After `uncertain`, later recipients in a live run (`--live` or `SPEND_LIVE=true`) are skipped and a `*halt*` JSONL row is appended so later runs that UTC day exit `4` without paying
- If a live process crashes, the next run steals the leftover lock once the owner pid is gone, or when this process reused the pid but the lock timestamp predates this incarnation. A lock whose pid belongs to a different live process is never stolen. Steal is serialized by a virgin `O_EXCL` `{day}.taking` file; an existing taking file is never replaced. Remove a lock or taking file by hand only after checking that no spend is running and inspecting `STATE_DIR/YYYY-MM-DD.jsonl`
- Unreadable JSONL (truncated/corrupt line) aborts with exit `4` (`corrupt_state`) so a damaged `paid`/`uncertain` row cannot be ignored
- State: `STATE_DIR/YYYY-MM-DD.jsonl`, `STATE_DIR/YYYY-MM-DD.finished`, `STATE_DIR/YYYY-MM-DD.lock` while a run is in progress, and `STATE_DIR/YYYY-MM-DD.taking` (`O_EXCL`, owner pid) briefly while a leftover lock is stolen

Exit codes: `0` ok, `1` drain timeout after SIGTERM/SIGINT (55s cap), `2` config, `3` preflight/balance/lock/spot, `4` failed, uncertain, or halted.

Secrets stay in `.env` / the LNDHub URI. They are never logged.
