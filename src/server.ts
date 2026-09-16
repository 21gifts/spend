import { readFileSync } from 'node:fs';
import { loadConfig, MODERATOR_STIPEND_USD, type Recipient, type SpendConfig } from './config';
import { loadDashboard } from './dashboard';
import { bearerMatchesDebugToken, bearerMatchesToken } from './debug-token';
import { parseLightningAddress } from './lightning-address';
import { LndhubClient, parseLndhubUri } from './lndhub';
import { createPayoutGate } from './payout-gate';
import { fetchBtcUsdSpot } from './price';
import {
  CorruptRecipientsError,
  ensureLiveRecipients,
  loadLiveRecipients,
  saveLiveRecipients,
} from './recipients-store';
import {
  renderDashboardHtml,
  renderUnconfiguredHtml,
  type SpendPanel,
} from './recipients-html';
import { runDay, type RunOptions } from './run';
import {
  SESSION_TTL_SEC,
  clearSessionCookie,
  mintSessionCookie,
  passwordsMatch,
  sessionCookieHeader,
  sessionCookieValid,
} from './session';
import { CorruptStateError, DayState, dayBlock, latestStatus } from './state';
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

/**
 * Parse `BIND_ADDR` (`host:port`).
 *
 * @param raw - Env value.
 * @returns Hostname and port.
 */
export function parseBindAddr(raw: string | undefined): { hostname: string; port: number } {
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

/**
 * HTTP app for the dashboard, recipient editor, health probe, operator debug, and ping-triggered payouts.
 *
 * @param opts - Env, fetch, clock, and optional `retryCatchupMs` (kept for tests; boot does not start a retry timer).
 * @returns Fetch handler, no-op scheduler/catch-up starters (kept for tests), payout runner, and payout drain.
 */
export function createServer(opts: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  retryCatchupMs?: number;
  runDay?: (
    config: SpendConfig,
    options: RunOptions,
  ) => Promise<{ exitCode: number }>;
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

  const loadOrError = ():
    | { ok: true; comment: string; recipients: Recipient[] }
    | { ok: false; response: Response } => {
    try {
      const liveList = loadLiveRecipients(config.stateDir);
      return { ok: true, comment: liveList.comment, recipients: liveList.recipients };
    } catch (err) {
      if (err instanceof CorruptRecipientsError) {
        return {
          ok: false,
          response: new Response('Recipient list is unreadable', { status: 500 }),
        };
      }
      throw err;
    }
  };

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/healthz') {
      const body = JSON.stringify({ status: 'ok', service: SERVICE_NAME, version });
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
        return json(200, { comment: liveList.comment, recipients: liveList.recipients });
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
      if (!bearerMatchesToken(config.giftsApiToken, req.headers.get('authorization') ?? undefined)) {
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
      const pingBody = body as { address: string; messageId?: unknown; kind?: unknown };
      const kindRaw = pingBody.kind;
      if (kindRaw !== undefined && kindRaw !== 'daily' && kindRaw !== 'moderator') {
        return json(400, { error: 'Expected a JSON body with address and kind' });
      }
      const kind: 'daily' | 'moderator' = kindRaw === 'moderator' ? 'moderator' : 'daily';
      if (kind === 'moderator') {
        if ('messageId' in pingBody) {
          return json(400, { error: 'Expected a JSON body with address and kind' });
        }
      } else if (typeof pingBody.messageId !== 'string' || !MESSAGE_ID_RE.test(pingBody.messageId)) {
        return json(400, { error: 'Expected a JSON body with address and messageId' });
      }
      const parsed = parseLightningAddress(pingBody.address);
      if (parsed === null) {
        return json(400, { error: 'Not a valid Lightning Address (expected name@domain)' });
      }
      const logPing = (status: string, reason?: string): void => {
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'spend.ping',
            address: parsed,
            status,
            ...(reason !== undefined ? { reason } : {}),
            ...(kind === 'moderator' ? { kind: 'moderator' } : {}),
          }),
        );
      };
      const clock = opts.now ?? (() => new Date());
      const day = clock().toISOString().slice(0, 10);
      if (kind === 'moderator') {
        const storedAddress = parsed;
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
          const block = dayBlock(rows, storedAddress);
          if (block === 'paid') {
            logPing('skipped', 'paid');
            return json(200, { status: 'skipped', reason: 'paid' });
          }
          if (latestStatus(rows, storedAddress) === 'failed') {
            logPing('skipped', 'failed');
            return json(200, { status: 'skipped', reason: 'failed' });
          }
        }
        logPing('accepted');
        void payout(day, 'ping', [storedAddress], undefined, {
          bucket: 'moderator',
          recipients: [
            {
              address: storedAddress,
              amountUsd: MODERATOR_STIPEND_USD,
              comment: '21gifts moderator',
            },
          ],
          comment: '21gifts moderator',
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
      let liveList: { comment: string; recipients: Recipient[] };
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
      if (listed === undefined) {
        logPing('skipped', 'not_listed');
        return json(200, { status: 'skipped', reason: 'not_listed' });
      }
      const storedAddress = listed.address;
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
      logPing('accepted');
      void payout(day, 'ping', [storedAddress], messageId).catch((err: unknown) => {
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
        return combinedPage({
          kind: 'editor',
          recipients: loadedLive.recipients,
          comment: loadedLive.comment,
        });
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

    if (
      req.method === 'POST' &&
      (url.pathname === '/recipients/add' ||
        url.pathname === '/recipients/update' ||
        url.pathname === '/recipients/delete' ||
        url.pathname === '/recipients/comment')
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
        let recipients = loadedLive.recipients.map((r) => ({ ...r }));

        if (url.pathname === '/recipients/comment') {
          const raw = form.get('comment');
          const parsed = parseComment(raw);
          if (!parsed.ok) {
            return combinedPage({
              kind: 'editor',
              recipients,
              comment: raw ?? '',
              error: 'Invalid comment',
            });
          }
          saveLiveRecipients(config.stateDir, { comment: parsed.comment, recipients });
          return redirect('/');
        }

        if (url.pathname === '/recipients/add') {
          const address = parseAddress(form.get('address'));
          const amountUsd = parseAmountUsd(form.get('amountUsd'));
          if (address === null || amountUsd === null) {
            return combinedPage({
              kind: 'editor',
              recipients,
              comment,
              error: 'Invalid address or amount',
            });
          }
          if (recipients.some((r) => r.address === address)) {
            return combinedPage({
              kind: 'editor',
              recipients,
              comment,
              error: 'Address already listed',
            });
          }
          recipients = [...recipients, { address, amountUsd }];
          saveLiveRecipients(config.stateDir, { comment, recipients });
          return redirect('/');
        }

        if (url.pathname === '/recipients/update') {
          const address = parseAddress(form.get('address'));
          const amountUsd = parseAmountUsd(form.get('amountUsd'));
          if (address === null) {
            return combinedPage({
              kind: 'editor',
              recipients,
              comment,
              error: 'Unknown address',
            });
          }
          const idx = recipients.findIndex((r) => r.address === address);
          if (idx < 0) {
            return combinedPage({
              kind: 'editor',
              recipients,
              comment,
              error: 'Unknown address',
            });
          }
          if (amountUsd === null) {
            return combinedPage({
              kind: 'editor',
              recipients,
              comment,
              error: 'Invalid address or amount',
            });
          }
          const current = recipients[idx];
          if (current === undefined) {
            return combinedPage({
              kind: 'editor',
              recipients,
              comment,
              error: 'Unknown address',
            });
          }
          recipients[idx] = { ...current, amountUsd };
          saveLiveRecipients(config.stateDir, { comment, recipients });
          return redirect('/');
        }

        const address = parseAddress(form.get('address'));
        if (address === null) {
          return combinedPage({
            kind: 'editor',
            recipients,
            comment,
            error: 'Unknown address',
          });
        }
        const next = recipients.filter((r) => r.address !== address);
        if (next.length === recipients.length) {
          return combinedPage({
            kind: 'editor',
            recipients,
            comment,
            error: 'Unknown address',
          });
        }
        saveLiveRecipients(config.stateDir, { comment, recipients: next });
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
      bucket?: 'moderator';
      recipients?: Recipient[];
      comment?: string;
    },
  ): Promise<{ exitCode: number }> =>
    gate.run(async () => {
      const moderator = extras?.bucket === 'moderator';
      let liveList: { comment: string; recipients: Recipient[] };
      if (moderator) {
        liveList = {
          comment: extras?.comment ?? '21gifts moderator',
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
            const summary = { ...minimalRunSummary(day, live, 4), reason: 'corrupt_recipients' };
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
      }
      const runOptions: RunOptions =
        onlyAddresses === undefined
          ? { live, day }
          : messageId === undefined
            ? moderator
              ? { live, day, onlyAddresses, bucket: 'moderator' }
              : { live, day, onlyAddresses }
            : {
                live,
                day,
                onlyAddresses,
                messageIdByAddress: Object.fromEntries(
                  onlyAddresses.map((address) => [address.toLowerCase(), messageId]),
                ),
              };
      const result = await (opts.runDay ?? runDay)(
        { ...config, recipients: liveList.recipients, comment: liveList.comment },
        runOptions,
      );
      const withSummary = result as { exitCode: number; summary?: RunSummary };
      const summary =
        withSummary.summary ?? minimalRunSummary(day, live, withSummary.exitCode);
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
   * No-op. Kept so tests can still call `startRetryCatchup().stop()`.
   *
   * @returns Handle whose `stop` does nothing.
   */
  const startRetryCatchup = (): { stop: () => void } => ({ stop: () => undefined });

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
      console.error(JSON.stringify({ event: 'spend.config', error: 'Bun.serve is required' }));
      process.exit(2);
    }
    bun.serve({
      hostname: bind.hostname,
      port: bind.port,
      fetch: app.fetch,
    });
    const shutdown = (): void => {
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
