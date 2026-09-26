import { isSundayRest, sundayRetryAfter } from './sunday-rest';
import { readFileSync } from 'node:fs';
import { loadConfig, type Recipient, type SpendConfig } from './config';
import { loadDashboard } from './dashboard';
import { bearerMatchesDebugToken, bearerMatchesToken } from './debug-token';
import { GiftsApi, type FundingGrantStatus } from './gifts-api';
import { parseLightningAddress } from './lightning-address';
import { LndhubClient, parseLndhubUri } from './lndhub';
import { createPayoutGate } from './payout-gate';
import { fetchBtcUsdSpot } from './price';
import {
  CorruptRecipientsError,
  ensureLiveRecipients,
  loadLiveRecipients,
  saveLiveRecipients,
  type LiveRecipients,
} from './recipients-store';
import { renderDashboardHtml, renderUnconfiguredHtml, type SpendPanel } from './recipients-html';
import { runDay, type RunOptions } from './run';
import {
  SESSION_TTL_SEC,
  clearSessionCookie,
  mintSessionCookie,
  passwordsMatch,
  sessionCookieHeader,
  sessionCookieValid,
} from './session';
import { appendRetryOwed, loadRetryOwed, type RetryOwed } from './retry-queue';
import { CorruptStateError, DayState, dayBlock, latestStatus, type StateRow } from './state';
import {
  loadTelegram,
  minimalRunSummary,
  notifyPayout,
  TelegramDedupe,
  type RunSummary,
  type TelegramSource,
} from './telegram';

const SERVICE_NAME = 'spend';
const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** New-member handbook cap (USD) for an unlisted daily ping with grant admitted or trial. */
const NEW_MEMBER_DAILY_USD = 1;
/** Once-per-Lightning-Address lifetime welcome gift (USD). */
const WELCOME_USD = 1;

/**
 * Parse `BIND_ADDR` (`host:port`).
 *
 * @param raw - Env value.
 * @returns Hostname and port.
 */
export function parseBindAddr(raw: string | undefined): {
  hostname: string;
  port: number;
} {
  const value = raw === undefined || raw.trim() === '' ? '0.0.0.0:3000' : raw.trim();
  const idx = value.lastIndexOf(':');
  if (idx <= 0 || idx === value.length - 1) {
    return { hostname: '0.0.0.0', port: 3000 };
  }
  const hostname = value.slice(0, idx);
  const port = Number(value.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { hostname: '0.0.0.0', port: 3000 };
  }
  return { hostname, port };
}

function serviceVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function htmlResponse(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function redirect(location: string, headers?: HeadersInit): Response {
  return new Response(null, {
    status: 303,
    headers: { location, ...headers },
  });
}

async function readForm(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await req.text();
    return new URLSearchParams(text);
  }
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const params = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }
    return params;
  }
  const text = await req.text();
  return new URLSearchParams(text);
}

function parseAmountUsd(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

// Dashboard editor is looser than ping/CLI: any non-empty string containing `@`.
function parseAddress(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const address = raw.trim();
  if (address === '' || !address.includes('@')) {
    return null;
  }
  return address;
}

function parseComment(raw: string | null): { ok: true; comment: string } | { ok: false } {
  if (raw === null) {
    return { ok: false };
  }
  const comment = raw.replace(/\r\n|\n|\r/g, ' ').trim();
  if (comment.length > 500) {
    return { ok: false };
  }
  return { ok: true, comment };
}

type RosterAction = 'add' | 'update' | 'delete';

/**
 * Apply add, update, or delete to one roster list. Error strings match the
 * existing recipient editor pages.
 *
 * @param action - Mutation kind.
 * @param list - Current rows for that list.
 * @param form - Posted fields (`address`, `amountUsd`).
 * @returns The next list, or an editor error string.
 */
function mutateRosterList(
  action: RosterAction,
  list: Recipient[],
  form: URLSearchParams,
): { ok: true; list: Recipient[] } | { ok: false; error: string } {
  if (action === 'add') {
    const address = parseAddress(form.get('address'));
    const amountUsd = parseAmountUsd(form.get('amountUsd'));
    if (address === null || amountUsd === null) {
      return { ok: false, error: 'Invalid address or amount' };
    }
    if (list.some((r) => r.address.toLowerCase() === address.toLowerCase())) {
      return { ok: false, error: 'Address already listed' };
    }
    return { ok: true, list: [...list, { address, amountUsd }] };
  }
  if (action === 'update') {
    const address = parseAddress(form.get('address'));
    const amountUsd = parseAmountUsd(form.get('amountUsd'));
    if (address === null) {
      return { ok: false, error: 'Unknown address' };
    }
    const idx = list.findIndex((r) => r.address === address);
    if (idx < 0) {
      return { ok: false, error: 'Unknown address' };
    }
    if (amountUsd === null) {
      return { ok: false, error: 'Invalid address or amount' };
    }
    const current = list[idx];
    if (current === undefined) {
      return { ok: false, error: 'Unknown address' };
    }
    const next = list.map((row, i) => (i === idx ? { ...current, amountUsd } : row));
    return { ok: true, list: next };
  }
  const address = parseAddress(form.get('address'));
  if (address === null) {
    return { ok: false, error: 'Unknown address' };
  }
  const next = list.filter((r) => r.address !== address);
  if (next.length === list.length) {
    return { ok: false, error: 'Unknown address' };
  }
  return { ok: true, list: next };
}

/**
 * Editor panel payload for the combined page.
 *
 * @param comment - Payment comment shown in the textarea.
 * @param recipients - Daily roster.
 * @param moderators - Moderator roster.
 * @param paymentsEnabled - Daily-payments switch.
 * @param moderatorPaymentsEnabled - Moderator-payments switch.
 * @param error - Optional error shown above the comment heading.
 * @returns `SpendPanel` editor variant.
 */
function editorPanel(
  comment: string,
  recipients: Recipient[],
  moderators: Recipient[],
  paymentsEnabled: boolean,
  moderatorPaymentsEnabled: boolean,
  error?: string,
): SpendPanel {
  return error === undefined
    ? {
        kind: 'editor',
        comment,
        recipients,
        moderators,
        paymentsEnabled,
        moderatorPaymentsEnabled,
      }
    : {
        kind: 'editor',
        comment,
        recipients,
        moderators,
        paymentsEnabled,
        moderatorPaymentsEnabled,
        error,
      };
}

const ROSTER_MUTATION = /^\/(recipients|moderators)\/(add|update|delete)$/;
const PAYMENTS_SWITCH = /^\/(recipients|moderators)\/payments$/;

/**
 * HTTP app for the dashboard, recipient editor, health probe, operator debug, and ping-triggered payouts.
 *
 * @param opts - Env, fetch, clock, and optional `retryCatchupMs` (overrides `RETRY_CATCHUP_MS`).
 * @returns Fetch handler, no-op midnight scheduler and boot catch-up, retry catch-up for owed `insufficient_balance` addresses when live and the interval is enabled, payout runner, and payout drain.
 */
export function createServer(opts: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  retryCatchupMs?: number;
  runDay?: (config: SpendConfig, options: RunOptions) => Promise<{ exitCode: number }>;
}): {
  fetch: (req: Request) => Promise<Response>;
  startScheduler: () => { stop: () => void };
  startCatchup: () => Promise<{ exitCode: number } | null>;
  startRetryCatchup: () => { stop: () => void };
  runPayout: (day: string) => Promise<{ exitCode: number }>;
  drainPayouts: () => Promise<void>;
} {
  const loaded = loadConfig(opts.env);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const telegram = loadTelegram(opts.env);
  if (!telegram.ok) {
    throw new Error(telegram.error);
  }
  const telegramTarget = telegram.target;
  const notifyLog = new TelegramDedupe();
  const config = loaded.config;
  /* v8 ignore start — seed was already parsed by loadConfig; copy is best-effort. */
  try {
    ensureLiveRecipients(config.stateDir, config.recipientsFile);
  } catch {
    // Seed copy is best-effort; payout still fail-closes on a bad live file.
  }
  /* v8 ignore stop */
  const fetchImpl = opts.fetchImpl ?? fetch;
  const live = opts.env['SPEND_LIVE'] === 'true';
  const debugToken = opts.env['DEBUG_TOKEN'];
  const target = parseLndhubUri(config.lndhubUri);
  if (target === null) {
    throw new Error('LNDHUB_URI must be an lndhub:// URI');
  }
  const lndhub = new LndhubClient(target, fetchImpl);
  const version = serviceVersion();
  const recipientsGate = createPayoutGate();
  const sessionNow = (): number => (opts.now ?? (() => new Date()))().getTime() / 1000;

  const requireSession = (req: Request): boolean => {
    const password = config.dashboardPassword;
    if (password === null) {
      return false;
    }
    return sessionCookieValid(req.headers.get('cookie'), password, sessionNow);
  };

  const requireSameOrigin = (req: Request): boolean => {
    const origin = req.headers.get('origin');
    if (origin === null || origin === '') {
      return false;
    }
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    const host = (req.headers.get('host') ?? new URL(req.url).host).split(',')[0]?.trim() ?? '';
    return host !== '' && originHost === host;
  };

  const loadDashboardData = () =>
    loadDashboard({
      lndhub,
      btcUsd: () => fetchBtcUsdSpot(fetchImpl),
      lightningAddress: config.lightningAddress,
    });

  /** Load dashboard then render the combined page (optional panel). */
  const combinedPage = async (panel?: SpendPanel): Promise<Response> => {
    const data = await loadDashboardData();
    return htmlResponse(renderDashboardHtml(data, panel));
  };

  /** Load dashboard then render Spend + unconfigured notice (HTTP 503). */
  const unconfiguredPage = async (): Promise<Response> => {
    const data = await loadDashboardData();
    return htmlResponse(renderUnconfiguredHtml(data), 503);
  };

  const loadOrError = (): ({ ok: true } & LiveRecipients) | { ok: false; response: Response } => {
    try {
      const liveList = loadLiveRecipients(config.stateDir);
      return {
        ok: true,
        comment: liveList.comment,
        recipients: liveList.recipients,
        moderators: liveList.moderators,
        paymentsEnabled: liveList.paymentsEnabled,
        moderatorPaymentsEnabled: liveList.moderatorPaymentsEnabled,
      };
    } catch (err) {
      if (err instanceof CorruptRecipientsError) {
        return {
          ok: false,
          response: new Response('Recipient list is unreadable', {
            status: 500,
          }),
        };
      }
      throw err;
    }
  };

  const fetchHandler = async (req: Request): Promise<Response> => {
    const timestamp = (opts.now ?? (() => new Date()))().getTime();
    if (new URL(req.url).pathname !== '/healthz' && isSundayRest(timestamp)) {
      return new Response(
        'Christ is risen! Rejoice in the risen Lord, visit him at Holy Mass, rest and set work and shopping aside. 21.gifts returns on Monday (Manila time).',
        {
          status: 503,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Retry-After': String(sundayRetryAfter(timestamp)),
          },
        },
      );
    }
    const url = new URL(req.url);
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/healthz') {
      const body = JSON.stringify({
        status: 'ok',
        service: SERVICE_NAME,
        version,
      });
      return new Response(req.method === 'HEAD' ? null : body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/debug/recipients') {
      const json = (status: number, payload: unknown): Response =>
        new Response(req.method === 'HEAD' ? null : JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      if (debugToken === undefined || debugToken.trim() === '') {
        return json(503, { error: 'Debug is not configured' });
      }
      if (!bearerMatchesDebugToken(debugToken, req.headers.get('authorization') ?? undefined)) {
        return json(401, { error: 'Unauthorized' });
      }
      try {
        const liveList = loadLiveRecipients(config.stateDir);
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'spend.debug.recipients',
            count: liveList.recipients.length,
          }),
        );
        return json(200, {
          comment: liveList.comment,
          recipients: liveList.recipients,
          moderators: liveList.moderators,
          paymentsEnabled: liveList.paymentsEnabled,
          moderatorPaymentsEnabled: liveList.moderatorPaymentsEnabled,
        });
      } catch (err) {
        if (err instanceof CorruptRecipientsError) {
          return json(500, { error: 'Recipient list is unreadable' });
        }
        throw err;
      }
    }
    if (req.method === 'POST' && url.pathname === '/ping') {
      const json = (status: number, payload: unknown): Response =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      if (
        !bearerMatchesToken(config.giftsApiToken, req.headers.get('authorization') ?? undefined)
      ) {
        return json(401, { error: 'Unauthorized' });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: 'Expected a JSON body with address' });
      }
      if (
        body === null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !('address' in body) ||
        typeof (body as { address: unknown }).address !== 'string'
      ) {
        return json(400, { error: 'Expected a JSON body with address' });
      }
      const pingBody = body as {
        address: string;
        messageId?: unknown;
        kind?: unknown;
        groupMessageId?: unknown;
      };
      const kindRaw = pingBody.kind;
      if (
        kindRaw !== undefined &&
        kindRaw !== 'daily' &&
        kindRaw !== 'moderator' &&
        kindRaw !== 'welcome'
      ) {
        return json(400, {
          error: 'Expected a JSON body with address and kind',
        });
      }
      const kind: 'daily' | 'moderator' | 'welcome' =
        kindRaw === 'moderator' ? 'moderator' : kindRaw === 'welcome' ? 'welcome' : 'daily';
      let groupMessageId: string | undefined;
      if (kind === 'moderator') {
        if ('messageId' in pingBody) {
          return json(400, {
            error: 'Expected a JSON body with address and kind',
          });
        }
        const rawGroupMessageId = pingBody.groupMessageId;
        if (rawGroupMessageId !== undefined) {
          if (typeof rawGroupMessageId !== 'string' || !MESSAGE_ID_RE.test(rawGroupMessageId)) {
            return json(400, {
              error: 'Expected a JSON body with address and kind',
            });
          }
          groupMessageId = rawGroupMessageId;
        }
      } else if (
        kind === 'daily' &&
        (typeof pingBody.messageId !== 'string' || !MESSAGE_ID_RE.test(pingBody.messageId))
      ) {
        return json(400, {
          error: 'Expected a JSON body with address and messageId',
        });
      }
      const parsed = parseLightningAddress(pingBody.address);
      if (parsed === null) {
        return json(400, {
          error: 'Not a valid Lightning Address (expected name@domain)',
        });
      }
      const logPing = (status: string, reason?: string): void => {
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'spend.ping',
            address: parsed,
            status,
            ...(reason !== undefined ? { reason } : {}),
            ...(kind === 'daily' ? {} : { kind }),
          }),
        );
      };
      const clock = opts.now ?? (() => new Date());
      const day = clock().toISOString().slice(0, 10);
      if (kind === 'welcome') {
        if (typeof pingBody.messageId !== 'string' || !MESSAGE_ID_RE.test(pingBody.messageId)) {
          return json(400, {
            error: 'Expected a JSON body with address and messageId',
          });
        }
        const messageId = pingBody.messageId;
        let liveList: LiveRecipients;
        try {
          liveList = loadLiveRecipients(config.stateDir);
        } catch (err) {
          if (err instanceof CorruptRecipientsError) {
            return json(500, { error: 'Recipient list is unreadable' });
          }
          throw err;
        }
        let storedAddress = parsed;
        let rows;
        try {
          rows = new DayState(config.stateDir, day, undefined, 'welcome').load();
        } catch (err) {
          if (!(err instanceof CorruptStateError)) {
            throw err;
          }
          rows = undefined;
        }
        if (rows !== undefined) {
          const persisted = rows.find((row) => row.address.toLowerCase() === parsed.toLowerCase());
          if (persisted !== undefined) {
            storedAddress = persisted.address;
          }
          const block = dayBlock(rows, storedAddress);
          if (block === 'paid') {
            logPing('skipped', 'paid');
            return json(200, { status: 'skipped', reason: 'paid' });
          }
          if (block === 'uncertain') {
            logPing('skipped', 'uncertain');
            return json(200, { status: 'skipped', reason: 'uncertain' });
          }
          if (latestStatus(rows, storedAddress) === 'failed') {
            logPing('skipped', 'failed');
            return json(200, { status: 'skipped', reason: 'failed' });
          }
        }
        if (liveList.paymentsEnabled === false) {
          logPing('skipped', 'payments_disabled');
          return json(200, { status: 'skipped', reason: 'payments_disabled' });
        }
        logPing('accepted');
        void payout(day, 'ping', [storedAddress], messageId, {
          bucket: 'welcome',
          recipients: [
            {
              address: storedAddress,
              amountUsd: WELCOME_USD,
              comment: 'Welcome',
            },
          ],
          comment: 'Welcome',
        }).catch((err: unknown) => {
          const error = err instanceof Error ? err.message : 'ping';
          console.warn(
            JSON.stringify({
              ts: new Date().toISOString(),
              event: 'spend.ping',
              address: storedAddress,
              status: 'error',
              error,
              kind: 'welcome',
            }),
          );
        });
        return json(202, { status: 'accepted' });
      }
      if (kind === 'moderator') {
        let liveList: LiveRecipients;
        try {
          liveList = loadLiveRecipients(config.stateDir);
        } catch (err) {
          if (err instanceof CorruptRecipientsError) {
            return json(500, { error: 'Recipient list is unreadable' });
          }
          throw err;
        }
        const listed = liveList.moderators.find(
          (recipient) => recipient.address.toLowerCase() === parsed.toLowerCase(),
        );
        if (listed === undefined) {
          logPing('skipped', 'not_listed');
          return json(200, { status: 'skipped', reason: 'not_listed' });
        }
        let storedAddress = listed.address;
        let rows;
        try {
          rows = new DayState(config.stateDir, day, undefined, 'moderator').load();
        } catch (err) {
          if (!(err instanceof CorruptStateError)) {
            throw err;
          }
          rows = undefined;
        }
        if (rows !== undefined) {
          const persisted = rows.find((row) => row.address.toLowerCase() === parsed.toLowerCase());
          if (persisted !== undefined) {
            storedAddress = persisted.address;
          }
          const block = dayBlock(rows, storedAddress);
          if (block === 'paid') {
            logPing('skipped', 'paid');
            return json(200, { status: 'skipped', reason: 'paid' });
          }
          if (block === 'uncertain') {
            logPing('skipped', 'uncertain');
            return json(200, { status: 'skipped', reason: 'uncertain' });
          }
          if (latestStatus(rows, storedAddress) === 'failed') {
            logPing('skipped', 'failed');
            return json(200, { status: 'skipped', reason: 'failed' });
          }
        }
        if (liveList.moderatorPaymentsEnabled === false) {
          logPing('skipped', 'payments_disabled');
          return json(200, { status: 'skipped', reason: 'payments_disabled' });
        }
        logPing('accepted');
        void payout(day, 'ping', [storedAddress], undefined, {
          bucket: 'moderator',
          recipients: [
            {
              address: storedAddress,
              amountUsd: listed.amountUsd,
              comment: '21gifts moderator',
            },
          ],
          comment: '21gifts moderator',
          ...(groupMessageId === undefined ? {} : { groupMessageId }),
        }).catch((err: unknown) => {
          const error = err instanceof Error ? err.message : 'ping';
          console.warn(
            JSON.stringify({
              ts: new Date().toISOString(),
              event: 'spend.ping',
              address: storedAddress,
              status: 'error',
              error,
              kind: 'moderator',
            }),
          );
        });
        return json(202, { status: 'accepted' });
      }
      const messageId = pingBody.messageId as string;
      let liveList: LiveRecipients;
      try {
        liveList = loadLiveRecipients(config.stateDir);
      } catch (err) {
        if (err instanceof CorruptRecipientsError) {
          return json(500, { error: 'Recipient list is unreadable' });
        }
        throw err;
      }
      const listed = liveList.recipients.find(
        (recipient) => recipient.address.toLowerCase() === parsed.toLowerCase(),
      );
      let storedAddress: string;
      let extraRecipients: Recipient[] | undefined;
      if (listed === undefined) {
        let grant: FundingGrantStatus;
        try {
          grant = await new GiftsApi(
            config.giftsApiUrl,
            config.giftsApiToken,
            fetchImpl,
          ).fundingGrantStatus(parsed);
        } catch {
          logPing('skipped', 'eligible_unreachable');
          return json(200, {
            status: 'skipped',
            reason: 'eligible_unreachable',
          });
        }
        if (grant !== 'admitted' && grant !== 'trial') {
          logPing('skipped', 'not_listed');
          return json(200, { status: 'skipped', reason: 'not_listed' });
        }
        storedAddress = parsed;
        extraRecipients = [{ address: storedAddress, amountUsd: NEW_MEMBER_DAILY_USD }];
      } else {
        storedAddress = listed.address;
      }
      let rows;
      try {
        rows = new DayState(config.stateDir, day).load();
      } catch (err) {
        if (!(err instanceof CorruptStateError)) {
          throw err;
        }
        rows = undefined;
      }
      if (rows !== undefined) {
        const block = dayBlock(rows, storedAddress);
        if (block === 'paid') {
          logPing('skipped', 'paid');
          return json(200, { status: 'skipped', reason: 'paid' });
        }
        if (
          block === 'uncertain' ||
          dayBlock(rows, '*halt*') === 'uncertain' ||
          liveList.recipients.some((recipient) => dayBlock(rows, recipient.address) === 'uncertain')
        ) {
          logPing('skipped', 'uncertain');
          return json(200, { status: 'skipped', reason: 'uncertain' });
        }
        if (latestStatus(rows, storedAddress) === 'failed') {
          logPing('skipped', 'failed');
          return json(200, { status: 'skipped', reason: 'failed' });
        }
      }
      if (liveList.paymentsEnabled === false) {
        logPing('skipped', 'payments_disabled');
        return json(200, { status: 'skipped', reason: 'payments_disabled' });
      }
      logPing('accepted');
      const queued =
        extraRecipients === undefined
          ? payout(day, 'ping', [storedAddress], messageId)
          : payout(day, 'ping', [storedAddress], messageId, {
              recipients: extraRecipients,
            });
      void queued.catch((err: unknown) => {
        const error = err instanceof Error ? err.message : 'ping';
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'spend.ping',
            address: storedAddress,
            status: 'error',
            error,
          }),
        );
      });
      return json(202, { status: 'accepted' });
    }
    if (req.method === 'HEAD' && url.pathname === '/') {
      return new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      if (config.dashboardPassword === null) {
        return combinedPage();
      }
      if (requireSession(req)) {
        const loadedLive = loadOrError();
        if (!loadedLive.ok) {
          return loadedLive.response;
        }
        return combinedPage(
          editorPanel(
            loadedLive.comment,
            loadedLive.recipients,
            loadedLive.moderators,
            loadedLive.paymentsEnabled,
            loadedLive.moderatorPaymentsEnabled,
          ),
        );
      }
      return combinedPage({ kind: 'login' });
    }

    if (req.method === 'GET' && url.pathname === '/login') {
      if (config.dashboardPassword === null) {
        return unconfiguredPage();
      }
      return redirect('/');
    }

    if (req.method === 'POST' && (url.pathname === '/login' || url.pathname === '/')) {
      if (config.dashboardPassword === null) {
        return unconfiguredPage();
      }
      if (!requireSameOrigin(req)) {
        return new Response('Forbidden', { status: 403 });
      }
      const form = await readForm(req);
      const submitted = form.get('password') ?? '';
      if (!passwordsMatch(config.dashboardPassword, submitted)) {
        return combinedPage({ kind: 'login', error: 'Invalid password' });
      }
      const value = mintSessionCookie(config.dashboardPassword, sessionNow);
      return redirect('/', {
        'set-cookie': sessionCookieHeader(value, req, SESSION_TTL_SEC),
      });
    }

    if (req.method === 'POST' && url.pathname === '/logout') {
      if (config.dashboardPassword !== null && !requireSameOrigin(req)) {
        return new Response('Forbidden', { status: 403 });
      }
      return redirect('/', {
        'set-cookie': sessionCookieHeader(clearSessionCookie(), req, 0),
      });
    }

    if (req.method === 'GET' && url.pathname === '/recipients') {
      if (config.dashboardPassword === null) {
        return unconfiguredPage();
      }
      return redirect('/');
    }

    const rosterMatch = ROSTER_MUTATION.exec(url.pathname);
    const paymentsMatch = PAYMENTS_SWITCH.exec(url.pathname);
    if (
      req.method === 'POST' &&
      (rosterMatch !== null || paymentsMatch !== null || url.pathname === '/recipients/comment')
    ) {
      if (config.dashboardPassword === null) {
        return unconfiguredPage();
      }
      if (!requireSession(req)) {
        return redirect('/');
      }
      if (!requireSameOrigin(req)) {
        return new Response('Forbidden', { status: 403 });
      }
      const form = await readForm(req);
      return recipientsGate.run(async () => {
        const loadedLive = loadOrError();
        if (!loadedLive.ok) {
          return loadedLive.response;
        }
        const comment = loadedLive.comment;
        const recipients = loadedLive.recipients.map((r) => ({ ...r }));
        const moderators = loadedLive.moderators.map((r) => ({ ...r }));

        if (url.pathname === '/recipients/comment') {
          const raw = form.get('comment');
          const parsed = parseComment(raw);
          if (!parsed.ok) {
            return combinedPage(
              editorPanel(
                raw ?? '',
                recipients,
                moderators,
                loadedLive.paymentsEnabled,
                loadedLive.moderatorPaymentsEnabled,
                'Invalid comment',
              ),
            );
          }
          saveLiveRecipients(config.stateDir, {
            comment: parsed.comment,
            recipients,
            moderators,
            paymentsEnabled: loadedLive.paymentsEnabled,
            moderatorPaymentsEnabled: loadedLive.moderatorPaymentsEnabled,
          });
          return redirect('/');
        }

        if (paymentsMatch !== null) {
          const enabledRaw = form.get('enabled');
          if (enabledRaw !== 'on' && enabledRaw !== 'off') {
            return combinedPage(
              editorPanel(
                comment,
                recipients,
                moderators,
                loadedLive.paymentsEnabled,
                loadedLive.moderatorPaymentsEnabled,
                'Invalid payments switch',
              ),
            );
          }
          const enabled = enabledRaw === 'on';
          const daily = paymentsMatch[1] === 'recipients';
          saveLiveRecipients(config.stateDir, {
            comment,
            recipients,
            moderators,
            paymentsEnabled: daily ? enabled : loadedLive.paymentsEnabled,
            moderatorPaymentsEnabled: daily ? loadedLive.moderatorPaymentsEnabled : enabled,
          });
          return redirect('/');
        }

        if (rosterMatch === null) {
          return new Response('Not found', { status: 404 });
        }
        const which = rosterMatch[1] === 'moderators' ? 'moderators' : 'recipients';
        const actionRaw = rosterMatch[2];
        const action: RosterAction =
          actionRaw === 'update' ? 'update' : actionRaw === 'delete' ? 'delete' : 'add';
        const current = which === 'recipients' ? recipients : moderators;
        const mutated = mutateRosterList(action, current, form);
        if (!mutated.ok) {
          return combinedPage(
            editorPanel(
              comment,
              recipients,
              moderators,
              loadedLive.paymentsEnabled,
              loadedLive.moderatorPaymentsEnabled,
              mutated.error,
            ),
          );
        }
        saveLiveRecipients(config.stateDir, {
          comment,
          recipients: which === 'recipients' ? mutated.list : recipients,
          moderators: which === 'moderators' ? mutated.list : moderators,
          paymentsEnabled: loadedLive.paymentsEnabled,
          moderatorPaymentsEnabled: loadedLive.moderatorPaymentsEnabled,
        });
        return redirect('/');
      });
    }

    return new Response('Not found', { status: 404 });
  };

  const gate = createPayoutGate();
  const payout = (
    day: string,
    source: TelegramSource,
    onlyAddresses?: string[],
    messageId?: string,
    extras?: {
      bucket?: 'moderator' | 'welcome';
      recipients?: Recipient[];
      comment?: string;
      groupMessageId?: string;
    },
  ): Promise<{ exitCode: number }> =>
    gate.run(async () => {
      if (isSundayRest((opts.now ?? (() => new Date()))().getTime())) return { exitCode: 0 };
      if (source === 'catchup') {
        const today = (opts.now ?? (() => new Date()))().toISOString().slice(0, 10);
        if (today !== day) {
          return { exitCode: 0 };
        }
      }
      const moderator = extras?.bucket === 'moderator';
      const welcome = extras?.bucket === 'welcome';
      const groupMessageId = extras?.groupMessageId;
      let liveList: { comment: string; recipients: Recipient[] };
      if (moderator || welcome) {
        liveList = {
          comment: extras?.comment ?? (welcome ? 'Welcome' : '21gifts moderator'),
          recipients: extras?.recipients ?? [],
        };
      } else {
        try {
          liveList = loadLiveRecipients(config.stateDir);
        } catch (err) {
          if (err instanceof CorruptRecipientsError) {
            console.warn(
              JSON.stringify({
                ts: new Date().toISOString(),
                event: 'spend.done',
                ok: false,
                reason: 'corrupt_recipients',
              }),
            );
            const summary = {
              ...minimalRunSummary(day, live, 4),
              reason: 'corrupt_recipients',
            };
            if (telegramTarget !== null && notifyLog.allow(source, summary)) {
              const sent = await notifyPayout({
                target: telegramTarget,
                summary,
                source,
                fetchImpl,
              });
              if (sent.ok) notifyLog.remember(source, summary);
            }
            return { exitCode: 4 };
          }
          throw err;
        }
        // Append only — replacing the live roster would let markFinished close the UTC day.
        if (extras?.recipients !== undefined) {
          liveList = {
            comment: liveList.comment,
            recipients: [...liveList.recipients, ...extras.recipients],
          };
        }
      }
      const runOptions: RunOptions =
        onlyAddresses === undefined
          ? { live, day }
          : messageId === undefined
            ? moderator
              ? {
                  live,
                  day,
                  onlyAddresses,
                  bucket: 'moderator',
                  ...(groupMessageId === undefined
                    ? {}
                    : {
                        groupMessageIdByAddress: Object.fromEntries(
                          onlyAddresses.map((address) => [address.toLowerCase(), groupMessageId]),
                        ),
                      }),
                }
              : { live, day, onlyAddresses }
            : {
                live,
                day,
                onlyAddresses,
                messageIdByAddress: Object.fromEntries(
                  onlyAddresses.map((address) => [address.toLowerCase(), messageId]),
                ),
                ...(welcome ? { bucket: 'welcome' as const } : {}),
              };
      if (source === 'ping' || source === 'catchup') runOptions.checkFundingEligible = false;
      const result = await (opts.runDay ?? runDay)(
        {
          ...config,
          recipients: liveList.recipients,
          comment: liveList.comment,
        },
        runOptions,
      );
      const withSummary = result as { exitCode: number; summary?: RunSummary };
      const returnedSummary = withSummary.summary;
      const summary = returnedSummary ?? minimalRunSummary(day, live, withSummary.exitCode);
      if (
        live &&
        onlyAddresses !== undefined &&
        onlyAddresses.length > 0 &&
        (source === 'ping' || source === 'catchup') &&
        returnedSummary?.reason === 'insufficient_balance'
      ) {
        const bucket =
          extras?.bucket === 'moderator'
            ? 'moderator'
            : extras?.bucket === 'welcome'
              ? 'welcome'
              : 'daily';
        for (const address of onlyAddresses) {
          const row: RetryOwed = { address, bucket };
          if (
            (bucket === 'daily' || bucket === 'welcome') &&
            messageId !== undefined &&
            MESSAGE_ID_RE.test(messageId)
          ) {
            row.messageId = messageId;
          }
          if (
            bucket === 'moderator' &&
            extras?.groupMessageId !== undefined &&
            MESSAGE_ID_RE.test(extras.groupMessageId)
          ) {
            row.groupMessageId = extras.groupMessageId;
          }
          if ((bucket === 'daily' || bucket === 'welcome') && extras?.recipients !== undefined) {
            const extra = extras.recipients.find(
              (recipient) => recipient.address.toLowerCase() === address.toLowerCase(),
            );
            if (extra !== undefined) {
              row.amountUsd = extra.amountUsd;
            }
          }
          try {
            appendRetryOwed(config.stateDir, day, row);
          } catch (err: unknown) {
            const error = err instanceof Error ? err.message : 'enqueue';
            console.warn(
              JSON.stringify({
                ts: new Date().toISOString(),
                event: 'spend.retry.enqueue',
                error,
              }),
            );
          }
        }
      }
      if (telegramTarget !== null && notifyLog.allow(source, summary)) {
        const sent = await notifyPayout({
          target: telegramTarget,
          summary,
          source,
          fetchImpl,
        });
        if (sent.ok) notifyLog.remember(source, summary);
      }
      return { exitCode: result.exitCode };
    });

  /**
   * No-op. Payouts are ping-triggered; boot must not pay the roster.
   *
   * @returns `null` without calling `runDay`.
   */
  const startCatchup = async (): Promise<{ exitCode: number } | null> => null;

  /**
   * Same-UTC-day retry of owed `insufficient_balance` addresses when live and the
   * interval is enabled. Midnight scheduler and boot catch-up stay no-ops.
   *
   * @returns Handle whose `stop` clears the interval (no-op when disabled).
   */
  const startRetryCatchup = (): { stop: () => void } => {
    const intervalMs = retryCatchupIntervalMs();
    if (!live || intervalMs <= 0) {
      return { stop: () => undefined };
    }
    let stopped = false;
    let inProgress = false;
    const tick = async (): Promise<void> => {
      if (stopped || inProgress) {
        return;
      }
      inProgress = true;
      try {
        await runRetryTick();
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : 'retry';
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'spend.retry',
            error,
          }),
        );
      } finally {
        inProgress = false;
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  };

  const retryCatchupIntervalMs = (): number => {
    if (typeof opts.retryCatchupMs === 'number' && Number.isFinite(opts.retryCatchupMs)) {
      return opts.retryCatchupMs;
    }
    const raw = opts.env['RETRY_CATCHUP_MS'];
    if (raw === undefined || raw.trim() === '') {
      return 900_000;
    }
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  };

  const runRetryTick = async (): Promise<void> => {
    if (isSundayRest((opts.now ?? (() => new Date()))().getTime())) return;
    const clock = opts.now ?? (() => new Date());
    const day = clock().toISOString().slice(0, 10);
    const owed = loadRetryOwed(config.stateDir, day);
    let liveList: LiveRecipients;
    try {
      liveList = loadLiveRecipients(config.stateDir);
    } catch (err) {
      if (err instanceof CorruptRecipientsError) {
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'spend.retry',
            error: err.message,
          }),
        );
        return;
      }
      throw err;
    }
    let dailyRows: StateRow[] | undefined;
    try {
      dailyRows = new DayState(config.stateDir, day).load();
    } catch (err) {
      if (!(err instanceof CorruptStateError)) {
        throw err;
      }
    }
    let moderatorRows: StateRow[] | undefined;
    try {
      moderatorRows = new DayState(config.stateDir, day, undefined, 'moderator').load();
    } catch (err) {
      if (!(err instanceof CorruptStateError)) {
        throw err;
      }
    }
    let welcomeRows: StateRow[] | undefined;
    try {
      welcomeRows = new DayState(config.stateDir, day, undefined, 'welcome').load();
    } catch (err) {
      if (!(err instanceof CorruptStateError)) {
        throw err;
      }
    }
    let dailyBlocked = false;
    if (dailyRows !== undefined) {
      const rows = dailyRows;
      dailyBlocked =
        dayBlock(rows, '*halt*') === 'uncertain' ||
        liveList.recipients.some((recipient) => dayBlock(rows, recipient.address) === 'uncertain');
    }
    for (const row of owed) {
      try {
        if (row.bucket === 'daily') {
          if (dailyRows === undefined) {
            continue;
          }
          if (liveList.paymentsEnabled === false) {
            continue;
          }
          if (dailyBlocked) {
            continue;
          }
          const block = dayBlock(dailyRows, row.address);
          if (
            block === 'paid' ||
            block === 'uncertain' ||
            latestStatus(dailyRows, row.address) === 'failed'
          ) {
            continue;
          }
          const listed = liveList.recipients.find(
            (recipient) => recipient.address.toLowerCase() === row.address.toLowerCase(),
          );
          if (listed !== undefined) {
            await payout(day, 'catchup', [listed.address], row.messageId);
            continue;
          }
          if (row.amountUsd !== undefined) {
            await payout(day, 'catchup', [row.address], row.messageId, {
              recipients: [{ address: row.address, amountUsd: row.amountUsd }],
            });
          }
          continue;
        }
        if (row.bucket === 'welcome') {
          if (welcomeRows === undefined) {
            continue;
          }
          if (liveList.paymentsEnabled === false) {
            continue;
          }
          const block = dayBlock(welcomeRows, row.address);
          if (
            block === 'paid' ||
            block === 'uncertain' ||
            latestStatus(welcomeRows, row.address) === 'failed'
          ) {
            continue;
          }
          await payout(day, 'catchup', [row.address], row.messageId, {
            bucket: 'welcome',
            recipients: [
              {
                address: row.address,
                amountUsd: row.amountUsd ?? WELCOME_USD,
                comment: 'Welcome',
              },
            ],
            comment: 'Welcome',
          });
          continue;
        }
        if (moderatorRows === undefined) {
          continue;
        }
        if (liveList.moderatorPaymentsEnabled === false) {
          continue;
        }
        const block = dayBlock(moderatorRows, row.address);
        if (
          block === 'paid' ||
          block === 'uncertain' ||
          latestStatus(moderatorRows, row.address) === 'failed'
        ) {
          continue;
        }
        const listed = liveList.moderators.find(
          (recipient) => recipient.address.toLowerCase() === row.address.toLowerCase(),
        );
        if (listed === undefined) {
          continue;
        }
        await payout(day, 'catchup', [listed.address], undefined, {
          bucket: 'moderator',
          recipients: [
            {
              address: listed.address,
              amountUsd: listed.amountUsd,
              comment: '21gifts moderator',
            },
          ],
          comment: '21gifts moderator',
          ...(row.groupMessageId === undefined ? {} : { groupMessageId: row.groupMessageId }),
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : 'retry';
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'spend.retry',
            error,
          }),
        );
      }
    }
  };

  return {
    fetch: fetchHandler,
    startScheduler: () => ({ stop: () => undefined }),
    startCatchup,
    startRetryCatchup,
    runPayout: (day: string) => payout(day, 'scheduler'),
    drainPayouts: () => gate.run(async () => undefined),
  };
}

/* v8 ignore start */
const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  try {
    const app = createServer({ env: process.env });
    const bind = parseBindAddr(process.env['BIND_ADDR']);
    const bun = (
      globalThis as {
        Bun?: {
          serve: (opts: {
            hostname: string;
            port: number;
            fetch: (req: Request) => Promise<Response>;
          }) => unknown;
        };
      }
    ).Bun;
    if (bun === undefined) {
      console.error(
        JSON.stringify({
          event: 'spend.config',
          error: 'Bun.serve is required',
        }),
      );
      process.exit(2);
    }
    bun.serve({
      hostname: bind.hostname,
      port: bind.port,
      fetch: app.fetch,
    });
    const retryCatchup = app.startRetryCatchup();
    const shutdown = (): void => {
      retryCatchup.stop();
      void app.drainPayouts().finally(() => {
        process.exit(0);
      });
      setTimeout(() => {
        process.exit(1);
      }, 55_000).unref();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'spend.listen',
        hostname: bind.hostname,
        port: bind.port,
      }),
    );
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : 'boot';
    console.error(JSON.stringify({ event: 'spend.config', error }));
    process.exit(2);
  }
}
/* v8 ignore stop */
