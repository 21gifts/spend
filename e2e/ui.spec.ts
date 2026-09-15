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

test('public / contains Log in and not the roster until logged in', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('Log in');
  expect(html).toContain('action="/"');
  expect(html).not.toContain('alice@w...');
  expect(html).not.toContain('action="/recipients/add"');
  expect(html).not.toContain('action="/recipients/comment"');
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
