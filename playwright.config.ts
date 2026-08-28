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
  webServer: {
    command: 'rm -rf e2e/.state && bun src/server.ts',
    url: `http://127.0.0.1:${spendPort}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      BIND_ADDR: `127.0.0.1:${spendPort}`,
      GIFTS_API_URL: 'http://127.0.0.1:3999',
      GIFTS_API_TOKEN: 'e2e-token',
      LNDHUB_URI: 'lndhub://admin:e2e@https://example.invalid/lndhub',
      RECIPIENTS_FILE: './recipients.example.json',
      STATE_DIR: './e2e/.state',
      SPEND_LIVE: 'false',
      SPEND_DASHBOARD_PASSWORD: 'test-password',
      SPEND_LIGHTNING_ADDRESS: '',
    },
  },
});
