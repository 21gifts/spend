import { expect, test } from '@playwright/test';

test('GET /recipients without a cookie redirects to /', async ({ request }) => {
  const res = await request.get('/recipients', { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers()['location']).toBe('/');
});

test('wrong password stays on / with error', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'nope');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.locator('body')).toContainText('Invalid password');
});

test('login, add, update, and delete recipients', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.locator('body')).toContainText('alice@w...');
  await expect(
    page.locator('li.row:has(input[name="address"][value="alice@walletofsatoshi.com"]) input[name=amountUsd]'),
  ).toHaveValue('1');
  await expect(page.locator('li.row.total .usd-total')).toHaveText('1');

  await page.locator('form[action="/recipients/add"] input[name=address]').fill('bob@walletofsatoshi.com');
  await page.locator('form[action="/recipients/add"] input[name=amountUsd]').fill('2');
  await page.locator('form[action="/recipients/add"] button').click();
  await expect(page.locator('li.row:has(input[name="address"][value="bob@walletofsatoshi.com"]) .addr')).toHaveText('bob@w...');
  await expect(page.locator('li.row.total .usd-total')).toHaveText('3');

  await page.locator('li.row:has(input[name="address"][value="bob@walletofsatoshi.com"]) input[name=amountUsd]').fill('3');
  await page.locator('li.row:has(input[name="address"][value="bob@walletofsatoshi.com"]) form[action="/recipients/update"] button').click();
  await expect(page.locator('li.row:has(input[name="address"][value="bob@walletofsatoshi.com"]) input[name=amountUsd]')).toHaveValue(
    '3',
  );
  await expect(page.locator('li.row.total .usd-total')).toHaveText('4');

  await page.locator('li.row:has(input[name="address"][value="bob@walletofsatoshi.com"]) form[action="/recipients/delete"] button').click();
  await expect(page.locator('li.row:has(input[name="address"][value="bob@walletofsatoshi.com"])')).toHaveCount(0);
  await expect(page.locator('li.row.total .usd-total')).toHaveText('1');
  await page.locator('li.row:has(input[name="address"][value="alice@walletofsatoshi.com"]) form[action="/recipients/delete"] button').click();
  await expect(page.locator('body')).toContainText('No recipients');
  await expect(page.locator('li.row.total')).toHaveCount(0);
});

test('login, add, update, and delete moderators', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.locator('h2', { hasText: 'Moderators' })).toBeVisible();
  await expect(page.locator('body')).toContainText('No moderators');

  await page.locator('form[action="/moderators/add"] input[name=address]').fill('mod@example.com');
  await page.locator('form[action="/moderators/add"] input[name=amountUsd]').fill('2');
  await page.locator('form[action="/moderators/add"] button').click();
  const moderatorRow = page.locator(
    'li.row:has(form[action="/moderators/update"]):has(input[name="address"][value="mod@example.com"])',
  );
  await expect(moderatorRow.locator('.addr')).toHaveText('mod@example.com');
  await expect(moderatorRow.locator('input[name=amountUsd]')).toHaveValue('2');
  await expect(
    page.locator('.card:has(form[action="/moderators/update"]) li.row.total .usd-total'),
  ).toHaveText('2');

  await moderatorRow.locator('input[name=amountUsd]').fill('3');
  await moderatorRow.locator('form[action="/moderators/update"] button').click();
  await expect(
    page
      .locator('li.row:has(form[action="/moderators/update"]):has(input[name="address"][value="mod@example.com"])')
      .locator('input[name=amountUsd]'),
  ).toHaveValue('3');
  await expect(
    page.locator('.card:has(form[action="/moderators/update"]) li.row.total .usd-total'),
  ).toHaveText('3');

  await page
    .locator('li.row:has(form[action="/moderators/delete"]):has(input[name="address"][value="mod@example.com"])')
    .locator('form[action="/moderators/delete"] button')
    .click();
  await expect(
    page.locator('li.row:has(form[action="/moderators/update"]):has(input[name="address"][value="mod@example.com"])'),
  ).toHaveCount(0);
  await expect(page.locator('body')).toContainText('No moderators');
});

test('public / contains Log in and not the roster until logged in', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('Log in');
  expect(html).toContain('action="/"');
  expect(html).not.toContain('alice@w...');
  expect(html).not.toContain('action="/recipients/add"');
  expect(html).not.toContain('action="/recipients/comment"');
  expect(html).not.toContain('action="/recipients/payments"');
  expect(html).not.toContain('action="/moderators/payments"');
});

test('login and edit the payment comment', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.locator('textarea[name=comment]')).toHaveValue('21gifts daily');
  await page.locator('form[action="/recipients/comment"] textarea[name=comment]').fill('hello gifts');
  await page.locator('form[action="/recipients/comment"] button').click();
  await expect(page).toHaveURL('/');
  await expect(page.locator('textarea[name=comment]')).toHaveValue('hello gifts');
});

test('login and toggle daily and moderator payments', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  const daily = page.locator('form[aria-label="Daily payments"]');
  const moderator = page.locator('form[aria-label="Moderator payments"]');
  await daily.locator('button[name="enabled"][value="off"]').click();
  await expect(daily.locator('button[name="enabled"][value="off"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await moderator.locator('button[name="enabled"][value="off"]').click();
  await expect(daily.locator('button[name="enabled"][value="off"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(moderator.locator('button[name="enabled"][value="off"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await daily.locator('button[name="enabled"][value="on"]').click();
  await expect(daily.locator('button[name="enabled"][value="on"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(moderator.locator('button[name="enabled"][value="off"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('Manila Sunday blocks the dashboard and payouts while liveness remains available', async ({
  request,
}) => {
  const origin = 'http://127.0.0.1:3351';
  const dashboard = await request.get(origin);
  expect(dashboard.status()).toBe(503);
  expect(await dashboard.text()).toContain('Christ is risen!');
  expect(dashboard.headers()['cache-control']).toBe('no-store');
  expect(Number(dashboard.headers()['retry-after'])).toBeGreaterThan(0);
  const ping = await request.post(`${origin}/ping`, {
    data: { lightningAddress: 'alice@example.com' },
  });
  expect(ping.status()).toBe(503);
  expect((await request.get(`${origin}/healthz`)).status()).toBe(200);
});
