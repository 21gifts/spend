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

test('login shows payment-page links and no moderator editor', async ({ page, request }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: 'Daily payment text', exact: true })).toHaveAttribute(
    'href',
    'https://21.gifts/grants/payments/comment',
  );
  await expect(page.getByRole('link', { name: 'Daily payment amounts', exact: true })).toHaveAttribute(
    'href',
    'https://21.gifts/grants/payments/amounts',
  );
  await expect(page.getByRole('link', { name: 'Moderator payments', exact: true })).toHaveAttribute(
    'href',
    'https://21.gifts/grants/payments/moderators',
  );
  await expect(page.locator('h2', { hasText: 'Moderators' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('No moderators');
  await expect(page.locator('form[action="/moderators/add"]')).toHaveCount(0);
  const add = await request.post('/moderators/add', {
    form: { address: 'mod@example.com', amountUsd: '2' },
    maxRedirects: 0,
  });
  expect(add.status()).toBe(404);
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

test('logged-in page has no payment switches', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.locator('form[aria-label="Daily payments"]')).toHaveCount(0);
  await expect(page.locator('form[aria-label="Moderator payments"]')).toHaveCount(0);
  await expect(page.locator('form[action="/moderators/payments"]')).toHaveCount(0);
});
