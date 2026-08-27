# 21gifts/spend

Daily Lightning gift payouts plus a tiny HTTP dashboard. This process **does not generate invoices**.

1. `POST {GIFTS_API_URL}/invoices` — 21.gifts api fetches the recipient BOLT11
2. LNDHub `payinvoice` on lightning.space
3. `POST {GIFTS_API_URL}/invoices/proof` with the **preimage** (`sha256` = payment hash)

Recipient amounts in `recipients.tondo.json` are **USD**. Each payout (midnight, catch-up, CLI) fetches Coinbase BTC-USD spot and pays `round(usd / btcUsd * 1e8)` sats. Missing or unusable spot is fail-closed (exit `3`). The optional `amountSats` field in the JSON is a snapshot only — the process does not read it.

The long-running server (`bun src/server.ts`) serves the dashboard and runs the UTC-midnight payout in-process. `SPEND_LIVE=true` pays; otherwise the scheduler is dry-run. On live boot it also runs a same-UTC-day catch-up (`spend.catchup`): already-`paid` JSONL rows are skipped, so a recipient added after midnight can still be paid on the next process start.

The dashboard at `GET /` shows only:

- current LNDHub balance in sats
- the same balance in USD (Coinbase BTC-USD spot)
- on-chain deposit address (text)
- the same address as a QR code

`GET /healthz` is the liveness probe. Nothing else is on the page.

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

Production image: `21gifts/spend:latest` (`linux/arm64`). `BIND_ADDR` defaults to `0.0.0.0:3000`. Recipients in the image are `recipients.tondo.json`. State is `STATE_DIR` (Docker: `/data`). Required env: `GIFTS_API_URL`, `GIFTS_API_TOKEN`, `LNDHUB_URI`. Set `SPEND_LIVE=true` to pay.

```bash
docker run -p 3000:3000 -v spend-state:/data \
  -e GIFTS_API_URL=https://api.21.gifts \
  -e GIFTS_API_TOKEN \
  -e LNDHUB_URI \
  -e SPEND_LIVE=true \
  21gifts/spend:latest
```

UTC midnight: the server samples the clock every 30s. It calls the existing payout only when UTC hour is 0 and the minute is 0–5. Exit `3` (lock/balance/spot) is retried on the next tick inside that window; exit `0`, `2`, or `4` ends the UTC day for this process. Same-day re-entry is still gated by JSONL (`paid` / `uncertain`). One-shot CLI still supports `--at-utc-midnight` for the same window.

## Fail-closed

- Coinbase BTC-USD spot is required before any invoice. Recipients are USD; sats are computed at that spot
- Balance preflight before the first pay (need remaining amount + `max(100 sats, 1%)` fee margin). LNDHub `balance` is sats as returned — not divided by 1000
- Every run takes an exclusive `STATE_DIR/YYYY-MM-DD.lock` (`O_EXCL`) for the process lifetime. A concurrent second run (live or dry-run) exits `3`. After a normal exit the lock file is removed; same-UTC-day re-entry is gated by JSONL (`paid` / `uncertain` / `*halt*`, not later `dry-run` rows)
- `uncertain` (network/5xx, missing preimage, proof failure, amount mismatch) is logged and **not** retried the same UTC day
- After `uncertain`, later recipients in a live run (`--live` or `SPEND_LIVE=true`) are skipped and a `*halt*` JSONL row is appended so later runs that UTC day exit `4` without paying
- If a live process crashes, the lock file remains. Remove it only after checking that no spend is running and inspecting `STATE_DIR/YYYY-MM-DD.jsonl`
- Unreadable JSONL (truncated/corrupt line) aborts with exit `4` (`corrupt_state`) so a damaged `paid`/`uncertain` row cannot be ignored
- State: `STATE_DIR/YYYY-MM-DD.jsonl`

Exit codes: `0` ok, `2` config, `3` preflight/balance/lock/spot, `4` failed, uncertain, or halted.

Secrets stay in `.env` / the LNDHub URI. They are never logged.
