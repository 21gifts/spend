# 21gifts/spend

Ping-triggered Lightning gift payouts plus a tiny HTTP dashboard. This process **does not generate invoices**.

1. `POST {GIFTS_API_URL}/invoices` — 21.gifts api fetches the recipient BOLT11
2. LNDHub `payinvoice` on lightning.space
3. `POST {GIFTS_API_URL}/invoices/proof` with the **preimage** (`sha256` = payment hash)

Recipient amounts are **USD**. Each payout (`POST /ping` or CLI) reads the live roster `STATE_DIR/recipients.json`, fetches Coinbase BTC-USD spot, and pays `round(usd / btcUsd * 1e8)` sats. Missing or unusable spot, or a conversion under 1 sat, is fail-closed (exit `3`). The optional `amountSats` field in a seed JSON is a snapshot only — the process does not read it.

The long-running server (`bun src/server.ts`) serves the dashboard, `POST /ping`, and `/healthz`. It does **not** pay the roster at UTC midnight, on boot catch-up, or on a 15-minute retry. There is no in-process midnight scheduler. A UTC day still starts at 00:00 UTC (existing JSONL day files). Payout happens when the 21.gifts API `POST`s `/ping` for a Lightning Address that is on the live roster, has no `paid` or persisted `failed` row for today, and today's JSONL has no `uncertain` row for that address, any other live recipient, or `*halt*`. Replies never reach this process; the API pings only for top-level posts. `SPEND_LIVE=true` pays; otherwise the queued run is dry-run.

`GET /` is the only UI page. It always shows the Spend block:

- current LNDHub balance in sats
- the same balance in USD (Coinbase BTC-USD spot)
- the configured **Lightning Address** (`SPEND_LIGHTNING_ADDRESS`) and a `lightning:` QR

Under that: when `SPEND_DASHBOARD_PASSWORD` is set and there is no session, a compact login form (`POST /`, still accepted at `POST /login`); when the session is valid, the recipient roster plus add and Log out, and a logged-in operator can edit the payment comment (the LUD-12 string sent with each invoice); when the password is unset, the dashboard only (no login form). The roster ends with a Total row summing USD amounts.

`GET /login` and `GET /recipients` redirect to `/` when the editor is configured. When the password is unset or blank, those paths return 503 (Spend block plus a muted notice) and `POST /ping` still pays. `GET /healthz` is the liveness probe (`HEAD /` and `HEAD /healthz` return 200 with an empty body). Optional `DEBUG_TOKEN` enables `GET /debug/recipients` (Bearer) returning the live comment and roster. Session cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, 12h; `Secure` when the request is HTTPS or `X-Forwarded-Proto: https`. Mutations are POST-only (`/recipients/add`, `/recipients/update`, `/recipients/delete`, `/recipients/comment`, `/logout`); after login, logout, and mutations the response redirects to `/`.

Wallet of Satoshi addresses render as `local@w...` in the editor; mutations still use the full address. Visual snapshots (`bun run e2e:visual`) are Linux/Chromium against a local mock wallet (sats, USD, QR); when login or editor layout changes, replace `e2e/visual.spec.ts-snapshots/` from the CI actuals.

Live roster: `STATE_DIR/recipients.json`. On first boot the seed at `RECIPIENTS_FILE` (process default `./recipients.json`; image `ENV` `/app/recipients.tondo.json`) is copied there if missing and is never overwritten afterwards. Ping and the CLI reload that live file each run. An empty list after deletes pays nothing. `POST /` (login; alias `POST /login`), `POST /logout`, and list mutations require a same-origin `Origin` header (host must match `Host`). `POST /ping` does not: it is api-to-api.

## POST /ping

Auth: `Authorization: Bearer` matching `GIFTS_API_TOKEN`. Missing or mismatch → `401` `{ "error": "Unauthorized" }`. No Origin / same-origin check.

Body: JSON `{ "address": string, "messageId": string }`. Invalid JSON or missing `address` → `400` `{ "error": "Expected a JSON body with address" }`. Missing or invalid `messageId` (must be a UUID) → `400` `{ "error": "Expected a JSON body with address and messageId" }`. The address is trimmed; it must look like `name@domain`, else `400` `{ "error": "Not a valid Lightning Address (expected name@domain)" }`. Match the live roster case-insensitively; use the roster-stored address as the payout key. A corrupt roster → `500` `{ "error": "Recipient list is unreadable" }`.

- Not on the live roster → `200` `{ "status": "skipped", "reason": "not_listed" }`
- Today's JSONL already `paid` or persisted `failed` for the pinged address → `200` skipped with that reason
- Today's JSONL already `uncertain` for the pinged address, any other live recipient, or `*halt*` → `200` `{ "status": "skipped", "reason": "uncertain" }`
- Otherwise `202` `{ "status": "accepted" }` without waiting for Lightning; queues a single-recipient payout. `SPEND_LIVE` still controls live vs dry-run.

Payout is still `POST /invoices` (BOLT11) plus proof. Spend forwards `messageId` on that invoice create so the api can show the gift as a reply under the post.

## Branches

Open every PR against **`develop`**, not `main`.

- Merge to `develop` → Deploy DEV (`21gifts/spend:beta`)
- Push to `develop` also opens `Release: develop -> main` when `main` is behind
- Merge that release PR to `main` → Deploy PRD (`21gifts/spend:latest`)

## Setup

```bash
cp .env.example .env
cp recipients.example.json recipients.json
# fill GIFTS_API_TOKEN and LNDHUB_URI (lndhub://admin:<key>@https://lightning.space/lndhub)
bun install
bun src/server.ts         # dashboard + POST /ping + /healthz
bun src/cli.ts            # one-shot dry-run (may walk the whole list)
bun src/cli.ts --date 2026-08-23  # dry-run for that UTC state day
bun src/cli.ts --live --address alice@walletofsatoshi.com  # one-shot real payment
```

`--live` without `--address` is rejected (exit `2`) so a one-shot cannot pay the whole list. Dry-run without `--address` may still walk the list.

Production image: `21gifts/spend:latest` (`linux/arm64`). `BIND_ADDR` defaults to `0.0.0.0:3000`. Recipients in the image are `recipients.tondo.json`. State is `STATE_DIR` (Docker: `/data`). Required env: `GIFTS_API_URL`, `GIFTS_API_TOKEN`, `LNDHUB_URI`. Optional: `SPEND_LIGHTNING_ADDRESS` (dashboard QR), `SPEND_DASHBOARD_PASSWORD` (recipient editor), `DEBUG_TOKEN` (Bearer for `GET /debug/recipients`; empty disables the route), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (plain-text payout notify — set **both** or **neither**; one alone or a bad format fails boot/CLI with exit `2`). Set `SPEND_LIVE=true` to pay.

After each payout (`POST /ping` or CLI), when Telegram is configured the process POSTs a plain-text summary to the chat. The Telegram body uses the unit `sat` on recipient and total lines and ends with a `total` of paid+dry-run amounts when those bags have amounts. Amounts in the Telegram body use Swiss grouping (apostrophe thousands, comma decimals), e.g. `1'000 sat` and `($3,5)`. When the summary includes a `reason` code, that line also names the human-readable form in parentheses after the code (for example `reason=insufficient_balance (insufficient balance)`). Wallet of Satoshi addresses in that message render as `local@w...`; the rest of the message is unchanged. Telegram send failures never change the payout exit code. Ping skips notify when the run only skipped recipients and has no `summary.reason` (already paid, `invoice_unreachable`, persisted failed — no spam on a skip-only ping). For ping, a given UTC-day preflight `summary.reason` with no paid/uncertain/dry-run lines is sent at most once per process (a `failed` bag that only mirrors that preflight, such as `usd_to_sats`, is still deduped, so an empty-wallet retry does not re-notify all day); a later run that pays still notifies. CLI notifies are not deduped.

```bash
docker run -p 3000:3000 -v spend-state:/data \
  -e GIFTS_API_URL=https://api.21.gifts \
  -e GIFTS_API_TOKEN \
  -e LNDHUB_URI \
  -e SPEND_LIVE=true \
  -e SPEND_LIGHTNING_ADDRESS=user@domain \
  21gifts/spend:latest
```

## CI / CD

| Workflow          | Trigger                   | Action                                                                 |
| ----------------- | ------------------------- | ---------------------------------------------------------------------- |
| `ci.yml`          | PR; push `main`/`develop` | typecheck + test                                                       |
| `deploy-dev.yaml` | push to `develop`         | Docker build → push `21gifts/spend:beta` → notify → wait for deploy    |
| `deploy-prd.yaml` | push to `main`            | Docker build → push `21gifts/spend:latest` → notify → wait for deploy  |

Images target `linux/arm64`.

Deploy workflows require GitHub Actions secrets `DOCKER_USERNAME`, `DOCKER_PASSWORD`, `DISPATCH_TOKEN` (PAT to dispatch `image-published` and read that run), and `DISPATCH_REPO` (target `owner/repo` that receives `image-published`). If `DISPATCH_TOKEN` or `DISPATCH_REPO` is missing, deploy fails loud (the image may already be on Hub). After `image-published`, the job waits for the infrastructure run whose title is `image-published 21gifts/spend:<tag> <sha>` and fails if that run does not succeed.

## Fail-closed

- One payout at a time in-process (concurrent pings share a queue). SIGTERM waits for the in-flight run (55s cap)
- `POST /invoices` 409 (`Already paid today`) is treated as already paid — no second Lightning pay
- JSONL appends are `fsync`'d so a restart does not lose a just-written `paid` row
- Coinbase BTC-USD spot is required before any invoice. Recipients are USD; sats are computed at that spot
- Balance preflight before the first pay (need remaining amount + `max(100 sats, 1%)` fee margin). LNDHub `balance` is sats as returned — not divided by 1000
- Every run takes an exclusive `STATE_DIR/YYYY-MM-DD.lock` (`O_EXCL`) for the process lifetime. A concurrent second run exits `3`. After a normal exit the lock file is removed only if it still holds this process's token. A leftover lock is stolen when its owner pid is dead, when the pid is this process but the lock was written before this process started (container PID reuse), or when the file has no pid and is older than 10 minutes. Same-UTC-day re-entry is gated by JSONL (`paid` / `uncertain` / `*halt*`) and `YYYY-MM-DD.finished` (survives restart). `POST /ping` skips `paid` and persisted `failed` for the pinged address, and skips `uncertain` when that address, any other live recipient, or `*halt*` is already `uncertain` today. `markFinished` still requires every live-roster recipient to be settled; a single ping does not finish the UTC day
- Invoice-create network/5xx **before any pay** (no invoice id) is `invoice_unreachable`: skipped, not persisted, no `*halt*`, no `.finished`, exit `3`. Later recipients in the same run are still attempted. A later `POST /ping` for that address can retry
- `uncertain` covers two cases that both halt the rest of a live run (`--live` or `SPEND_LIVE=true`), append a `*halt*` JSONL row, `markFinished`, exit `4`, and are **not** retried the same UTC day: (1) invoice-create parse failures (`malformed invoice response` / `malformed paymentHash`) without a pay; (2) after an invoice id / pay attempt (amount mismatch, lndhub.pay error, missing/mismatched preimage, proof failure)
- Persisted `failed` (invoice 4xx) is not paid again the same UTC day, does not count in the balance preflight sum, and when every live recipient is paid/uncertain/failed, `.finished` is set
- Only Lightning Addresses that currently have a passkey on 21.gifts and a live non-profile forum post are paid (live `GET /invoices/passkey` and `GET /invoices/posted` each run). Addresses without a passkey (or without an account) are skipped as `no_passkey` with no JSONL row so a later ping can retry the same UTC day; addresses with a passkey but no live forum post are skipped as `no_post` the same way. Invoice-create `403` `Forum post required` is the same `no_post` skip (not persisted `failed`). A failed passkey lookup aborts the whole run with exit `3` (`passkey_unreachable`) and pays no one; a failed posted lookup does the same as `posted_unreachable`
- If a live process crashes, the next run steals the leftover lock once the owner pid is gone, or when this process reused the pid but the lock timestamp predates this incarnation. A lock whose pid belongs to a different live process is never stolen. Steal is serialized by a virgin `O_EXCL` `{day}.taking` file; an existing taking file is never replaced. Remove a lock or taking file by hand only after checking that no spend is running and inspecting `STATE_DIR/YYYY-MM-DD.jsonl`
- Unreadable JSONL (truncated/corrupt line) aborts with exit `4` (`corrupt_state`) so a damaged `paid`/`uncertain` row cannot be ignored
- State: `STATE_DIR/YYYY-MM-DD.jsonl`, `STATE_DIR/YYYY-MM-DD.finished`, `STATE_DIR/YYYY-MM-DD.lock` while a run is in progress, and `STATE_DIR/YYYY-MM-DD.taking` (`O_EXCL`, owner pid) briefly while a leftover lock is stolen

Exit codes: `0` ok, `1` drain timeout after SIGTERM/SIGINT (55s cap), `2` config, `3` preflight/balance/lock/spot/invoice-create unreachable, `4` failed, uncertain, or halted.

Secrets stay in `.env` / the LNDHub URI. They are never logged.
