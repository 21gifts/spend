import { readFileSync } from 'node:fs';
import { loadConfig } from './config';
import { loadDashboard, renderDashboardHtml } from './dashboard';
import { LndhubClient, parseLndhubUri } from './lndhub';
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
 * @returns Fetch handler and scheduler starter.
 */
export function createServer(opts: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): { fetch: (req: Request) => Promise<Response>; startScheduler: () => { stop: () => void } } {
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

  return {
    fetch: fetchHandler,
    startScheduler: () => {
      const scheduler = {
        live,
        run: (day: string) => runDay(config, { live, day }),
      };
      if (opts.now === undefined) {
        return startMidnightScheduler(scheduler);
      }
      return startMidnightScheduler({ ...scheduler, now: opts.now });
    },
  };
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  try {
    const app = createServer({ env: process.env });
    const bind = parseBindAddr(process.env['BIND_ADDR']);
    app.startScheduler();
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
