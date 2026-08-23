import { readFileSync } from 'node:fs';

/** One payout recipient. */
export interface Recipient {
  address: string;
  amountSats: number;
  comment?: string;
}

/** Loaded operator config. */
export interface SpendConfig {
  giftsApiUrl: string;
  giftsApiToken: string;
  lndhubUri: string;
  recipientsFile: string;
  stateDir: string;
  comment: string;
  recipients: Recipient[];
}

interface RecipientsFile {
  comment?: unknown;
  recipients?: unknown;
}

/**
 * Read env + recipients JSON.
 *
 * @param env - Process env.
 * @param readFile - Injected file reader (tests).
 * @returns Config or a message explaining what is missing.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): { ok: true; config: SpendConfig } | { ok: false; error: string } {
  const giftsApiUrl = trimOrEmpty(env['GIFTS_API_URL']);
  const giftsApiToken = trimOrEmpty(env['GIFTS_API_TOKEN']);
  const lndhubUri = trimOrEmpty(env['LNDHUB_URI']);
  const recipientsFile = trimOrEmpty(env['RECIPIENTS_FILE']) || './recipients.json';
  const stateDir = trimOrEmpty(env['STATE_DIR']) || './state';

  if (giftsApiUrl === '') {
    return { ok: false, error: 'GIFTS_API_URL is required' };
  }
  if (giftsApiToken === '') {
    return { ok: false, error: 'GIFTS_API_TOKEN is required' };
  }
  if (lndhubUri === '') {
    return { ok: false, error: 'LNDHUB_URI is required' };
  }
  if (!lndhubUri.startsWith('lndhub://')) {
    return { ok: false, error: 'LNDHUB_URI must be an lndhub:// URI' };
  }

  let raw: string;
  try {
    raw = readFile(recipientsFile);
  } catch {
    return { ok: false, error: `cannot read recipients file ${recipientsFile}` };
  }

  let parsed: RecipientsFile;
  try {
    parsed = JSON.parse(raw) as RecipientsFile;
  } catch {
    return { ok: false, error: 'recipients file is not JSON' };
  }

  const fileComment = typeof parsed.comment === 'string' ? parsed.comment : '21gifts daily';
  if (!Array.isArray(parsed.recipients) || parsed.recipients.length === 0) {
    return { ok: false, error: 'recipients file must list at least one recipient' };
  }

  const recipients: Recipient[] = [];
  for (const item of parsed.recipients) {
    if (item === null || typeof item !== 'object') {
      return { ok: false, error: 'each recipient must be an object' };
    }
    const rec = item as { address?: unknown; amountSats?: unknown; comment?: unknown };
    if (typeof rec.address !== 'string' || !rec.address.includes('@')) {
      return { ok: false, error: 'each recipient needs a Lightning Address' };
    }
    if (typeof rec.amountSats !== 'number' || !Number.isInteger(rec.amountSats) || rec.amountSats < 1) {
      return { ok: false, error: 'each recipient needs amountSats >= 1' };
    }
    const row: Recipient = { address: rec.address, amountSats: rec.amountSats };
    if (typeof rec.comment === 'string') {
      row.comment = rec.comment;
    }
    recipients.push(row);
  }

  return {
    ok: true,
    config: {
      giftsApiUrl: giftsApiUrl.replace(/\/+$/, ''),
      giftsApiToken,
      lndhubUri,
      recipientsFile,
      stateDir,
      comment: fileComment,
      recipients,
    },
  };
}

function trimOrEmpty(value: string | undefined): string {
  return value === undefined ? '' : value.trim();
}
