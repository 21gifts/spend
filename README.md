# 21gifts/spend

Ping-triggered Lightning gift payouts plus a tiny HTTP dashboard. This process **does not generate invoices**.

1. `POST {GIFTS_API_URL}/invoices` — 21.gifts api fetches the recipient BOLT11
2. LNDHub `payinvoice` on lightning.space
3. `POST {GIFTS_API_URL}/invoices/proof` with the **preimage** (`sha256` = payment hash)

Recipient amounts are **USD**. `POST /ping` pays only the `amountUsd` and `comment` in the JSON body (it does not read the roster to choose whom or how much). The CLI asks `POST /spend/daily-instruction` for `--address` (live or dry-run) or, on a dry-run without `--address`, the addresses stored on the live roster in file order, and signs only `action: pay`. It does not read roster `amountUsd`, the file comment, or `paymentsEnabled` to decide. Both fetch Coinbase BTC-USD spot and pay `round(usd / btcUsd * 1e8)` sats. The invoice POST sends that USD amount as `amountUsd` with two decimals, and sats are still `round(usd / spot * 1e8)`. Missing or unusable spot, or a conversion under 1 sat, is fail-closed (exit `3`). The optional `amountSats` field in a seed JSON is a snapshot only — the process does not read it.

The long-running server (`bun src/server.ts`) serves the dashboard, `POST /ping`, and `/healthz`. `runPayout`, UTC midnight, and boot do not pay the roster. There is still no in-process midnight scheduler. A UTC day still starts at 00:00 UTC (existing JSONL day files). A payout happens when the 21.gifts API `POST`s `/ping` with a complete instruction (`address`, `amountUsd`, and `comment`, plus `messageId` for daily/welcome). Spend does not choose the amount, choose the comment, read the live roster to decide whom to pay, honor `paymentsEnabled` or `moderatorPaymentsEnabled`, look up a funding grant, apply the 1 USD default, or apply passkey, forum-post, or media rules. Execution safety stays: do not pay the same address twice the same UTC day (`paid`, `uncertain`, or persisted `failed`); a daily ping or daily retry still stops when the daily state has an uncertain `*halt*` row. Replies never reach this process; the API pings only for top-level posts. `SPEND_LIVE=true` pays; otherwise the queued run is dry-run. A live ping that returns `insufficient_balance` is written to `STATE_DIR/YYYY-MM-DD.retry.jsonl` (stored `amountUsd` and `comment`) and retried the same UTC day only. The default interval is 15 minutes (`RETRY_CATCHUP_MS`, milliseconds; unset means 900000; `0` disables), with one pass when the process starts the timer. The retry pays only those owed addresses that still have a stored amount and comment, through the same one-at-a-time gate, and does not send Telegram again for the same preflight reason. A later paid run still notifies. The retry does not read the live roster or either payments switch. A row with no comment or no amount is left unpaid. No day-file `failed` or `uncertain` row is written for this reason, so a new ping the same day is still allowed.

`GET /` is the only UI page. It always shows the Spend block:

- current LNDHub balance in sats
- the same balance in USD (Coinbase BTC-USD spot)
- the configured **Lightning Address** (`SPEND_LIGHTNING_ADDRESS`) and a `lightning:` QR

Under that: when `SPEND_DASHBOARD_PASSWORD` is set and there is no session, a compact login form (`POST /`, still accepted at `POST /login`); when the session is valid, two buttons, **Daily payment text** (`https://21.gifts/grants/payments/comment`) and **Daily payment amounts** (`https://21.gifts/grants/payments/amounts`), then a Moderators section (roster card with rows and a Total, or “No moderators” when empty, plus add), an On/Off switch for moderator stipend payments, and Log out. The daily roster, the daily payments switch, and the file-level payment comment are not edited on this page; the buttons open those pages on 21.gifts, and this process still stores them through the Bearer JSON API in [Daily roster](#daily-roster). When the password is unset, the dashboard only (no login form, no daily-payment buttons, no moderator switch). The moderator roster ends with a Total row summing USD amounts.

`GET /login` and `GET /recipients` redirect to `/` when the editor is configured. When the password is unset or blank, those paths return 503 (Spend block plus a muted notice) and `POST /ping` still pays. `GET /healthz` is the liveness probe (`HEAD /` and `HEAD /healthz` return 200 with an empty body). Optional `DEBUG_TOKEN` enables `GET /debug/recipients` (Bearer) returning the live comment, `recipients`, `moderators`, `paymentsEnabled`, and `moderatorPaymentsEnabled`. Session cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, 12h; `Secure` when the request is HTTPS or `X-Forwarded-Proto: https`. Cookie mutations are POST-only (`/moderators/add`, `/moderators/update`, `/moderators/delete`, `/moderators/payments`, `/logout`); after login, logout, and those mutations the response redirects to `/`. `POST /recipients/add`, `/recipients/update`, `/recipients/delete`, `/recipients/comment`, and `/recipients/payments` return 404 with no session check. Adding a moderator address that is already on that list in any letter case is refused (`Address already listed`), because pings match addresses case-insensitively. The moderator payment switch posts `enabled=on` or `enabled=off`; the matching button is pressed. The stored `paymentsEnabled` flag remains on the roster file and the daily-roster JSON API; spend does not consult it when paying. `POST /ping` and the same-day retry sign the instructed amount and comment and do not decide.

Wallet of Satoshi addresses render as `local@w...` in the moderator editor; mutations still use the full address. Visual snapshots (`bun run e2e:visual`) are Linux/Chromium against a local mock wallet (sats, USD, QR); when login or editor layout changes, replace `e2e/visual.spec.ts-snapshots/` from the CI actuals.

Live roster: `STATE_DIR/recipients.json` (`comment`, `recipients`, `moderators`, `paymentsEnabled`, and `moderatorPaymentsEnabled`; each row `{ "address", "amountUsd" }`). A missing `moderators` key is an empty list so existing live files keep working; seeds may carry it. Missing `paymentsEnabled` or `moderatorPaymentsEnabled` means that stored flag is treated as enabled for the file and JSON API; spend does not consult either flag when paying. The two flags are independent. On first boot the seed at `RECIPIENTS_FILE` (process default `./recipients.json`; image `ENV` `/app/recipients.tondo.json`) is copied there if missing and is never overwritten afterwards. The CLI reloads that live file each run as an address list for a dry-run without `--address`. Ping does not. An empty address list exits `0` without calling `dailyInstruction`, without `runDay`, and without Telegram. `POST /` (login; alias `POST /login`), `POST /logout`, and moderator mutations (`/moderators/add`, `/moderators/update`, `/moderators/delete`, `/moderators/payments`) require a same-origin `Origin` header (host must match `Host`). `POST /ping` and the daily-roster JSON API do not: they are api-to-api.

## Daily roster

Auth: `Authorization: Bearer` matching `GIFTS_API_TOKEN` (same token as `POST /ping`). Missing or mismatch → `401` `{ "error": "Unauthorized" }`. No Origin / same-origin check. Cookie sessions are not accepted.

`GET /daily-roster` and every successful POST below return `{ "comment", "paymentsEnabled", "defaultAmountUsd", "recipients": [{ "address", "amountUsd" }] }`. `defaultAmountUsd` is the new-member handbook cap (`NEW_MEMBER_DAILY_USD`) for the 21.gifts editor. It is not stored in the live file and spend does not apply it on ping. The body has no per-row comment, no `moderators`, and no `moderatorPaymentsEnabled`. A corrupt live file → `500` `{ "error": "Recipient list is unreadable" }`. A body that is not a JSON object → `400` `{ "error": "Expected a JSON body" }`.

- `POST /daily-roster/comment` `{ "comment": string }` — newlines become spaces, then trim, max 500 characters. Empty after trim is kept. A non-string → `400` `{ "error": "Invalid comment" }`.
- `POST /daily-roster/payments` `{ "enabled": boolean }` only (`"on"`, `1`, and `"true"` are rejected) → `400` `{ "error": "Invalid payments switch" }`. Sets `paymentsEnabled` only.
- `POST /daily-roster/recipients` `{ "address", "amountUsd" }`. Address is trimmed, non-empty, and must contain `@`. `amountUsd` must be a finite number greater than 0 (numeric strings are not coerced). A case-insensitive duplicate → `400` `{ "error": "Address already listed" }`. Anything else unparsable → `400` `{ "error": "Invalid address or amount" }`. The new row has no per-row comment.
- `POST /daily-roster/recipients/update` matches the address exactly after trim (not case-insensitive). An unparsable or unknown address → `400` `{ "error": "Unknown address" }`. A known address with a bad amount → `400` `{ "error": "Invalid address or amount" }`. Other fields on that row are kept.
- `POST /daily-roster/recipients/delete` — unknown or unparsable → `400` `{ "error": "Unknown address" }`.

These writes load the full live file, change only the daily fields, and save `comment`, `recipients`, `moderators`, `paymentsEnabled`, and `moderatorPaymentsEnabled` together. They do not reset the other flag. The file-level comment is stored on the roster; the CLI does not copy it onto a payment. Ping uses the instructed `comment`.

## POST /ping

Auth: `Authorization: Bearer` matching `GIFTS_API_TOKEN`. Missing or mismatch → `401` `{ "error": "Unauthorized" }`. No Origin / same-origin check.

Spend executes only a payment the caller already decided. After a structurally valid ping (kind, `messageId`, `groupMessageId`, and address checks), a missing or unusable `amountUsd`/`comment` pair → `400` `{ "error": "Expected a JSON body with address, amountUsd, and comment" }`. That 400 does not load the roster, does not call the gifts API, and does not call payout.

Three kinds. `kind` omitted or `"daily"` writes the daily JSONL. `"kind": "moderator"` writes the moderator JSONL. `"kind": "welcome"` writes `welcome.jsonl`. Invalid JSON or missing `address` → `400` `{ "error": "Expected a JSON body with address" }`. A `kind` that is neither `"daily"` nor `"moderator"` nor `"welcome"` → `400` `{ "error": "Expected a JSON body with address and kind" }`. The address is trimmed; it must look like `name@domain`, else `400` `{ "error": "Not a valid Lightning Address (expected name@domain)" }`.

Ping does not choose the amount, choose the comment, read the live roster to decide whom to pay, honor `paymentsEnabled` or `moderatorPaymentsEnabled`, look up a funding grant, apply the 1 USD default, or apply passkey, forum-post, or media rules.

### Daily

Body: JSON `{ "address": string, "messageId": string, "amountUsd": number, "comment": string }` (`kind` may be omitted or `"daily"`). Missing or invalid `messageId` (must be a UUID) → `400` `{ "error": "Expected a JSON body with address and messageId" }`.

- Today's JSONL already `paid` or persisted `failed` for the pinged address → `200` skipped with that reason
- Today's JSONL already `uncertain` for the pinged address, or `*halt*` is `uncertain` → `200` `{ "status": "skipped", "reason": "uncertain" }`. Another address's `uncertain` row does not skip this ping.
- Otherwise `202` `{ "status": "accepted" }` without waiting for Lightning; queues a single-recipient payout of that `amountUsd` and `comment`. `SPEND_LIVE` still controls live vs dry-run.

Payout is still `POST /invoices` (BOLT11) plus proof. Spend forwards `messageId` on that invoice create so the api can show the gift as a reply under the post. Daily state is `STATE_DIR/YYYY-MM-DD.jsonl` and `YYYY-MM-DD.finished`.

A run skips with `welcome_paid` and writes no JSONL row when `POST /invoices` returns 403 with error exactly `Welcome gift already paid`. Spend records that 403 as `welcome_paid` for any bucket. Spend does not read `welcome.jsonl` to decide a daily skip. The skip does not set `summary.reason`. `403` `Passkey required` is `no_passkey`. `403` `Forum post required` is `no_media` for welcome and `no_post` otherwise. `403` `Funding grant required` is `not_eligible` (no JSONL, `summary.reason` unset), any bucket.

### Moderator

Body: JSON `{ "address": string, "kind": "moderator", "amountUsd": number, "comment": string, "groupMessageId"?: string }`. Do not send `messageId` — any `messageId` with this kind → `400` `{ "error": "Expected a JSON body with address and kind" }`. `groupMessageId` (optional UUID) is the Moderators-group message that triggered the ping; spend forwards it on `POST /invoices` so the api can show the paid stipend in the group. A malformed `groupMessageId` is a `400`.

State is a separate JSONL: `STATE_DIR/YYYY-MM-DD.moderator.jsonl` and `YYYY-MM-DD.moderator.finished`. Match the moderator JSONL case-insensitively; the first persisted address is the payout key, otherwise the parsed address. Once per UTC day per address on that file (`paid`, persisted `failed`, or own-address `uncertain` → `200` skipped with that reason). A `*halt*` row or another address's `uncertain` in the moderator JSONL does not skip this ping (the daily file still never skips a moderator ping). The moderator file does not skip a daily ping. `moderatorPaymentsEnabled` is not read.

Amount and comment are the instructed pair. Same in-process payout gate as daily (one run at a time). The midnight scheduler stays a no-op; an insufficient-balance retry can still pay that same instruction later the same UTC day. Otherwise `202` `{ "status": "accepted" }` without waiting for Lightning. No `messageId` is ever sent for the moderator kind; `groupMessageId` is sent on that same `POST /invoices` call when the ping carried one.

### Welcome

Body: JSON `{ "address": string, "kind": "welcome", "messageId": string, "amountUsd": number, "comment": string }`. `messageId` is a required UUID (same 400 as daily): missing or invalid → `400` `{ "error": "Expected a JSON body with address and messageId" }`. A stray `groupMessageId` is ignored.

Match `welcome.jsonl` case-insensitively; the first persisted address is the payout key, otherwise the parsed address. Own-address `paid` / persisted `failed` / own-address `uncertain` in `welcome.jsonl` skip with that reason; daily and moderator files do not skip a welcome ping. A `*halt*` row or another address's `uncertain` in `welcome.jsonl` does not skip this ping. `paymentsEnabled` is not read. Amount and comment are the instructed pair. Otherwise `202` `{ "status": "accepted" }` without waiting for Lightning.

## Branches

Open every feature pull request against **`develop`**, not `staging` and not `main`. Developers rebase `staging` onto `develop` regularly, because those pull requests land on `develop` and do not update `staging`.

- Merge to `develop` → Deploy DEV (`21gifts/spend:beta`)
- Push to `develop` also opens `Release: develop -> main` when `main` is behind
- Merge that release PR to `main` → Deploy PRD (`21gifts/spend:latest`)
- If the release PR has no file changes (identical trees even though develop is commit-ahead), close it instead of squash-merging. The next push to `develop` opens a new one; merge that only when it has a real diff.
- **Hard requirement:** `staging` is the environment for experimental testing. It builds `21gifts/spend:staging`. A change that is good there is released to `develop` first (`Release: staging -> develop`). `main` receives changes only from `develop` (`Release: develop -> main`). `staging` is never released directly to `main`.

## Setup

```bash
cp .env.example .env
cp recipients.example.json recipients.json
# fill GIFTS_API_TOKEN and LNDHUB_URI (lndhub://admin:<key>@https://lightning.space/lndhub)
bun install
bun src/server.ts         # dashboard + POST /ping + /healthz
bun src/cli.ts            # one-shot dry-run (asks daily-instruction for stored addresses)
bun src/cli.ts --date 2026-08-23  # dry-run for that UTC state day
bun src/cli.ts --live --address alice@walletofsatoshi.com  # one-shot real payment
```

`--live` without `--address` is rejected (exit `2`) so a one-shot cannot pay the whole list. Dry-run without `--address` asks `POST /spend/daily-instruction` for the addresses currently stored on the live roster, in file order. A skip is not a payment. An empty address list exits `0`. When every answer is skip: one `spend.skip` per address, exit `0`, no Telegram. `400` and `401` are `spend.config` exit `2`. Any other instruction failure is `spend.done` `reason=instruction_unreachable`, exit `3`, no Telegram. When there is at least one `pay`, CLI `runDay`'s recipient list is only those pay instructions, so `markFinished` for that run is against that list, not every address stored in the live roster. `moderatorPaymentsEnabled` does not affect the CLI (the CLI only runs the daily bucket). Re-enabling daily payments later does not replay an already settled address and does not block a not-yet-attempted address the same UTC day.

Production image: `21gifts/spend:latest` (`linux/arm64`). `BIND_ADDR` defaults to `0.0.0.0:3000`. Recipients in the image are `recipients.tondo.json`. State is `STATE_DIR` (Docker: `/data`). Required env: `GIFTS_API_URL`, `GIFTS_API_TOKEN`, `LNDHUB_URI`. Optional: `SPEND_LIGHTNING_ADDRESS` (dashboard QR), `SPEND_DASHBOARD_PASSWORD` (password-gated moderator editor), `DEBUG_TOKEN` (Bearer for `GET /debug/recipients`; empty disables the route), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (plain-text payout notify — set **both** or **neither**; one alone or a bad format fails boot/CLI with exit `2`). Set `SPEND_LIVE=true` to pay.

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

| Workflow                 | Trigger                                                           | Action                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                 | PR (including drafts; not `ready_for_review`); push `main`/`develop` | Typecheck (`bun run typecheck`) + test (100% coverage) + e2e                                                                      |
| `deploy-dev.yaml`        | push to `develop`                                                 | Docker build → push `21gifts/spend:beta` → notify → wait for deploy                                                               |
| `deploy-staging.yaml`    | push to `staging`                                                 | Docker build → push `21gifts/spend:staging` → notify → wait for deploy                                                            |
| `deploy-prd.yaml`        | push to `main`                                                    | Docker build → push `21gifts/spend:latest` → notify → wait for deploy                                                             |
| `auto-release-pr.yaml`   | push to `develop` or `staging`                                    | Auto-create Release PRs (`staging → develop`, and `develop → main` only)                                                          |
| `a38-guard.yml`          | `pull_request_target`; PR comments; schedule; `workflow_dispatch` | `dfx pr guard` verifies the A38 report, releases held fork runs of `ci.yml`, and sets ready; never checks out the PR code         |

Images target `linux/arm64`.

Deploy workflows require GitHub Actions secrets `DOCKER_USERNAME`, `DOCKER_PASSWORD`, `DISPATCH_TOKEN` (PAT to dispatch `image-published` and read that run), and `DISPATCH_REPO` (target `owner/repo` that receives `image-published`). If `DISPATCH_TOKEN` or `DISPATCH_REPO` is missing, deploy fails loud (the image may already be on Hub). After `image-published`, the job waits for the infrastructure run whose title is `image-published 21gifts/spend:<tag> <sha>` and fails if that run does not succeed.

## Fail-closed

- One payout at a time in-process (concurrent pings share a queue). SIGTERM waits for the in-flight run (55s cap)
- `POST /invoices` 409 (`Already paid today`) is treated as already paid — no second Lightning pay
- JSONL appends are `fsync`'d so a restart does not lose a just-written `paid` row
- Coinbase BTC-USD spot is required before any invoice. Recipients are USD; sats are computed at that spot
- Balance preflight before the first pay (need remaining amount + `max(100 sats, 1%)` fee margin). LNDHub `balance` is sats as returned — not divided by 1000
- Every run takes an exclusive `STATE_DIR/YYYY-MM-DD.lock` (`O_EXCL`) for the process lifetime. A concurrent second run exits `3`. After a normal exit the lock file is removed only if it still holds this process's token. A leftover lock is stolen when its owner pid is dead, when the pid is this process but the lock was written before this process started (container PID reuse), or when the file has no pid and is older than 10 minutes. Daily same-UTC-day re-entry is gated by JSONL (`paid` / `uncertain` / `*halt*`) and `YYYY-MM-DD.finished` (survives restart). Moderator re-entry is own-address rows in `YYYY-MM-DD.moderator.jsonl` plus `YYYY-MM-DD.moderator.finished` (`*halt*` does not gate). Welcome re-entry is own-address rows in `welcome.jsonl` plus optional `welcome.finished` (`*halt*` does not gate; lifetime, not per UTC day). `POST /ping` skips `paid` and persisted `failed` for the pinged address. For daily / omitted `kind`, it also skips `uncertain` when that address or `*halt*` is already `uncertain` today. For `kind: "moderator"` and `kind: "welcome"`, skip is own-address paid / persisted failed / own-address uncertain only; a `*halt*` row or another address's uncertain does not skip (see Moderator / Welcome). For CLI daily, `markFinished` is against that run's pay-instruction list, not every address stored in the live roster. For ping, `markFinished` is against the instructed recipient list of that run. For moderator, `markFinished` writes `YYYY-MM-DD.moderator.finished` once that address is paid/uncertain/failed. For welcome, `markFinished` writes `welcome.finished` (never the daily `${day}.finished`)
- Invoice-create network/5xx **before any pay** (no invoice id) is `invoice_unreachable`: skipped, not persisted, no `*halt*`, no `.finished`, exit `3`. Later recipients in the same run are still attempted. A later `POST /ping` for that address can retry
- `uncertain` covers two cases that both halt the rest of a **daily** live run (`--live` or `SPEND_LIVE=true`), append a `*halt*` JSONL row, `markFinished`, exit `4`, and are **not** retried the same UTC day: (1) invoice-create parse failures (`malformed invoice response` / `malformed paymentHash`) without a pay; (2) after an invoice id / pay attempt (amount mismatch, lndhub.pay error, missing/mismatched preimage, proof failure). Moderator and welcome live runs do not append `*halt*` and do not stop later addresses in the same run
- Persisted `failed` (invoice 4xx) is not paid again the same UTC day, does not count in the balance preflight sum, and for daily, when every recipient of that run is paid/uncertain/failed, `.finished` is set. For moderator, `.moderator.finished` is set when the synthetic stipend list of that run is settled
- Invoice-create `403` `Passkey required` is skip `no_passkey` (no JSONL, `summary.reason` unset). `403` `Welcome gift already paid` is `welcome_paid` the same way, any bucket. `403` `Forum post required` is `no_media` for welcome and `no_post` otherwise. `403` `Funding grant required` is `not_eligible` (no JSONL, `summary.reason` unset), any bucket. Spend does not read `welcome.jsonl` to decide a daily skip. There is no policy preflight and no `GET /invoices/passkey`, `/invoices/posted`, or `/invoices/eligible` lookup before pay
- If a live process crashes, the next run steals the leftover lock once the owner pid is gone, or when this process reused the pid but the lock timestamp predates this incarnation. A lock whose pid belongs to a different live process is never stolen. Steal is serialized by a virgin `O_EXCL` `{day}.taking` file; an existing taking file is never replaced. Remove a lock or taking file by hand only after checking that no spend is running and inspecting `STATE_DIR/YYYY-MM-DD.jsonl`, `STATE_DIR/YYYY-MM-DD.moderator.jsonl`, and `STATE_DIR/welcome.jsonl`
- Unreadable JSONL (truncated/corrupt line) aborts with exit `4` (`corrupt_state`) so a damaged `paid`/`uncertain` row cannot be ignored
- State: `STATE_DIR/YYYY-MM-DD.jsonl`, `STATE_DIR/YYYY-MM-DD.finished`, `STATE_DIR/YYYY-MM-DD.moderator.jsonl`, `STATE_DIR/YYYY-MM-DD.moderator.finished`, `STATE_DIR/welcome.jsonl`, `STATE_DIR/welcome.finished`, `STATE_DIR/YYYY-MM-DD.retry.jsonl` (owed-address queue for same-UTC-day `insufficient_balance` retries; not a payout log), `STATE_DIR/YYYY-MM-DD.lock` while a run is in progress, and `STATE_DIR/YYYY-MM-DD.taking` (`O_EXCL`, owner pid) briefly while a leftover lock is stolen

Exit codes: `0` ok, `1` drain timeout after SIGTERM/SIGINT (55s cap), `2` config, `3` preflight/balance/lock/spot/invoice-create unreachable, `4` failed, uncertain, or halted.

Secrets stay in `.env` / the LNDHub URI. They are never logged.
