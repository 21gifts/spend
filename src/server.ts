import { readFileSync } from 'node:fs';
import { loadConfig, type SpendConfig } from './config';
import { loadDashboard, renderDashboardHtml } from './dashboard';
import { LndhubClient, parseLndhubUri } from './lndhub';
import { createPayoutGate } from './payout-gate';
import { fetchBtcUsdSpot } from './price';
import { runDay } from './run';
import { startMidnightScheduler } from './scheduler';

const SERVICE_NAME = 'spend';

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

/**
 * HTTP app for the dashboard and health probe.
 *
 * @param opts - Env, fetch, and clock.
 * @returns Fetch handler, midnight scheduler starter, and live catch-up starter.
 */
export function createServer(opts: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  runDay?: (
    config: SpendConfig,
    options: { live: boolean; day: string },
  ) => Promise<{ exitCode: number }>;
}): {
  fetch: (req: Request) => Promise<Response>;
  startScheduler: () => { stop: () => void };
  startCatchup: () => Promise<{ exitCode: number } | null>;
  drainPayouts: () => Promise<void>;
} {
  const loaded = loadConfig(opts.env);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const config = loaded.config;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const live = opts.env['SPEND_LIVE'] === 'true';
  const target = parseLndhubUri(config.lndhubUri);
  if (target === null) {
    throw new Error('LNDHUB_URI must be an lndhub:// URI');
  }
  const lndhub = new LndhubClient(target, fetchImpl);
  const version = serviceVersion();

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return Response.json({ status: 'ok', service: SERVICE_NAME, version });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const data = await loadDashboard({
        lndhub,
        btcUsd: () => fetchBtcUsdSpot(fetchImpl),
      });
      return new Response(renderDashboardHtml(data), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response('Not found', { status: 404 });
  };

  const gate = createPayoutGate();
  const payout = (day: string): Promise<{ exitCode: number }> =>
    gate.run(() => (opts.runDay ?? runDay)(config, { live, day }));

  return {
    fetch: fetchHandler,
    startScheduler: () => {
      const scheduler = { live, run: payout };
      if (opts.now === undefined) {
        return startMidnightScheduler(scheduler);
      }
      return startMidnightScheduler({ ...scheduler, now: opts.now });
    },
    /**
     * Live catch-up: pay remaining recipients for the current UTC day even
     * outside the midnight window (JSONL skips already-paid rows).
     */
    startCatchup: async (): Promise<{ exitCode: number } | null> => {
      if (!live) {
        return null;
      }
      const clock = opts.now ?? (() => new Date());
      const day = clock().toISOString().slice(0, 10);
      try {
        const result = await payout(day);
        console.warn(
          JSON.stringify({
            ts: clock().toISOString(),
            event: 'spend.catchup',
            day,
            live: true,
            exitCode: result.exitCode,
          }),
        );
        return result;
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : 'catchup';
        console.warn(
          JSON.stringify({
            ts: clock().toISOString(),
            event: 'spend.catchup',
            day,
            live: true,
            error,
          }),
        );
        return null;
      }
    },
    drainPayouts: () => gate.run(async () => undefined),
  };
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  try {
    const app = createServer({ env: process.env });
    const bind = parseBindAddr(process.env['BIND_ADDR']);
    const bun = (globalThis as { Bun?: { serve: (opts: { hostname: string; port: number; fetch: (req: Request) => Promise<Response> }) => unknown } }).Bun;
    if (bun === undefined) {
      console.error(JSON.stringify({ event: 'spend.config', error: 'Bun.serve is required' }));
      process.exit(2);
    }
    bun.serve({
      hostname: bind.hostname,
      port: bind.port,
      fetch: app.fetch,
    });
    const scheduler = app.startScheduler();
    void app.startCatchup();
    const shutdown = (): void => {
      scheduler.stop();
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
