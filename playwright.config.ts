import { defineConfig } from '@playwright/test';

const spendPort = 3350;

export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${spendPort}`,
  },
  webServer: [
    {
      command: 'bun e2e/mock-wallet.ts',
      url: 'http://127.0.0.1:3998/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'rm -rf e2e/.state && bun --preload ./e2e/server-clock.mjs src/server.ts',
      url: `http://127.0.0.1:${spendPort}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        E2E_CLOCK_ISO: '2026-09-24T12:00:00.000Z',
        BIND_ADDR: `127.0.0.1:${spendPort}`,
        GIFTS_API_URL: 'http://127.0.0.1:3999',
        GIFTS_API_TOKEN: 'e2e-token',
        LNDHUB_URI: 'lndhub://admin:e2e@http://127.0.0.1:3998',
        RECIPIENTS_FILE: './recipients.example.json',
        STATE_DIR: './e2e/.state',
        SPEND_LIVE: 'false',
        SPEND_DASHBOARD_PASSWORD: 'test-password',
        SPEND_LIGHTNING_ADDRESS: '9643e3@lightning.space',
        BTC_USD_SPOT_URL: 'http://127.0.0.1:3998/v2/prices/BTC-USD/spot',
      },
    },
    {
      command: 'bun --preload ./e2e/server-clock.mjs src/server.ts',
      url: 'http://127.0.0.1:3351/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        E2E_CLOCK_ISO: '2026-09-27T04:00:00.000Z',
        BIND_ADDR: '127.0.0.1:3351',
        GIFTS_API_URL: 'http://127.0.0.1:3999',
        GIFTS_API_TOKEN: 'e2e-token',
        LNDHUB_URI: 'lndhub://admin:e2e@http://127.0.0.1:3998',
        RECIPIENTS_FILE: './recipients.example.json',
        STATE_DIR: './e2e/.state/sunday',
        SPEND_LIVE: 'false',
        SPEND_DASHBOARD_PASSWORD: 'test-password',
      },
    },
  ],
});
