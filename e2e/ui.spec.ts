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

test('bearer token adds, updates, and deletes daily recipients', async ({ request }) => {
  const headers = {
    authorization: 'Bearer e2e-token',
    'content-type': 'application/json',
  };
  const listed = await request.get('/daily-roster', { headers });
  expect(listed.status()).toBe(200);
  const before = (await listed.json()) as {
    recipients: { address: string; amountUsd: number }[];
  };
  expect(before.recipients.map((row) => row.address)).toContain('alice@walletofsatoshi.com');

  const added = await request.post('/daily-roster/recipients', {
    headers,
    data: { address: 'bob@walletofsatoshi.com', amountUsd: 2 },
  });
  expect(added.status()).toBe(200);
  const afterAdd = (await added.json()) as {
    recipients: { address: string; amountUsd: number }[];
  };
  expect(afterAdd.recipients).toContainEqual({
    address: 'bob@walletofsatoshi.com',
    amountUsd: 2,
  });

  const updated = await request.post('/daily-roster/recipients/update', {
    headers,
    data: { address: 'bob@walletofsatoshi.com', amountUsd: 3 },
  });
  expect(updated.status()).toBe(200);
  const afterUpdate = (await updated.json()) as {
    recipients: { address: string; amountUsd: number }[];
  };
  expect(afterUpdate.recipients).toContainEqual({
    address: 'bob@walletofsatoshi.com',
    amountUsd: 3,
  });

  const deleted = await request.post('/daily-roster/recipients/delete', {
    headers,
    data: { address: 'bob@walletofsatoshi.com' },
  });
  expect(deleted.status()).toBe(200);
  const afterDelete = (await deleted.json()) as {
    recipients: { address: string; amountUsd: number }[];
  };
  expect(afterDelete.recipients.map((row) => row.address)).not.toContain('bob@walletofsatoshi.com');
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

test('bearer token edits the payment comment and the daily payments switch', async ({ request }) => {
  const headers = {
    authorization: 'Bearer e2e-token',
    'content-type': 'application/json',
  };
  const comment = await request.post('/daily-roster/comment', {
    headers,
    data: { comment: 'hello gifts' },
  });
  expect(comment.status()).toBe(200);
  expect(await comment.json()).toMatchObject({ comment: 'hello gifts' });
  const off = await request.post('/daily-roster/payments', {
    headers,
    data: { enabled: false },
  });
  expect(off.status()).toBe(200);
  expect(await off.json()).toMatchObject({ paymentsEnabled: false, comment: 'hello gifts' });
  const on = await request.post('/daily-roster/payments', {
    headers,
    data: { enabled: true },
  });
  expect(on.status()).toBe(200);
  expect(await on.json()).toMatchObject({ paymentsEnabled: true });
});

test('login and toggle moderator payments', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.locator('form[aria-label="Daily payments"]')).toHaveCount(0);
  const moderator = page.locator('form[aria-label="Moderator payments"]');
  await moderator.locator('button[name="enabled"][value="off"]').click();
  await expect(moderator.locator('button[name="enabled"][value="off"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await moderator.locator('button[name="enabled"][value="on"]').click();
  await expect(moderator.locator('button[name="enabled"][value="on"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
