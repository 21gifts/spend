# 21gifts/spend

Daily Lightning gift payouts. This process **does not generate invoices**.

1. `POST {GIFTS_API_URL}/invoices` — 21.gifts api fetches the recipient BOLT11
2. LNDHub `payinvoice` on lightning.space
3. `POST {GIFTS_API_URL}/invoices/proof` with the **preimage** (`sha256` = payment hash)

Default is dry-run (fetch + log, no pay). `--live` actually pays.

## Setup

```bash
cp .env.example .env
cp recipients.example.json recipients.json
# fill GIFTS_API_TOKEN and LNDHUB_URI (lndhub://admin:<key>@https://lightning.space/lndhub)
bun install
bun src/cli.ts            # dry-run
bun src/cli.ts --live     # real payments
```

Cron (UTC midnight):

```
0 0 * * * cd /path/to/spend && set -a && . ./.env && set +a && bun src/cli.ts --live
```

## Fail-closed

- Balance preflight before the first pay (need remaining amount + `max(100 sats, 1%)` fee margin)
- `uncertain` (network/5xx, missing preimage, proof failure) is logged and **not** retried the same UTC day
- After `uncertain`, later recipients in a `--live` run are skipped
- State: `STATE_DIR/YYYY-MM-DD.jsonl`

Exit codes: `0` ok, `2` config, `3` preflight/balance, `4` failed or uncertain.

Secrets stay in `.env` / the LNDHub URI. They are never logged.
