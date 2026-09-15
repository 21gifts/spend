/** Local LNDHub + Coinbase-shaped spot for Playwright. */

const hostname = '127.0.0.1';
const port = Number(process.env['MOCK_WALLET_PORT'] ?? 3998);

const server = Bun.serve({
  hostname,
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') {
      return new Response('ok');
    }
    if (url.pathname === '/auth' && req.method === 'POST') {
      return Response.json({ access_token: 'e2e-token' });
    }
    if (url.pathname === '/balance' && req.method === 'GET') {
      return Response.json({ BTC: { AvailableBalance: 500_000 } });
    }
    if (url.pathname === '/v2/prices/BTC-USD/spot' && req.method === 'GET') {
      return Response.json({ data: { amount: '77500' } });
    }
    return new Response('not found', { status: 404 });
  },
});

console.warn(
  JSON.stringify({
    ts: new Date().toISOString(),
    event: 'mock-wallet.listen',
    hostname: server.hostname,
    port: server.port,
  }),
);
