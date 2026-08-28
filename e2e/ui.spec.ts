import { expect, test } from '@playwright/test';

test('GET /recipients without a cookie redirects to login', async ({ request }) => {
  const res = await request.get('/recipients', { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers()['location']).toBe('/login');
});

test('wrong password stays on login', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[name=password]', 'nope');
  await page.click('button[type=submit]');
  await expect(page.locator('body')).toContainText('Invalid password');
});

test('login, add, update, and delete recipients', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/recipients/);
  await expect(page.locator('body')).toContainText('alice@walletofsatoshi.com');
  await expect(
    page.locator('tr:has-text("alice@walletofsatoshi.com") input[name=amountUsd]'),
  ).toHaveValue('1');

  await page.locator('form[action="/recipients/add"] input[name=address]').fill('bob@walletofsatoshi.com');
  await page.locator('form[action="/recipients/add"] input[name=amountUsd]').fill('2');
  await page.locator('form[action="/recipients/add"] button').click();
  await expect(page.locator('body')).toContainText('bob@walletofsatoshi.com');

  await page.locator('tr:has-text("bob@walletofsatoshi.com") input[name=amountUsd]').fill('3');
  await page.locator('tr:has-text("bob@walletofsatoshi.com") form[action="/recipients/update"] button').click();
  await expect(page.locator('tr:has-text("bob@walletofsatoshi.com") input[name=amountUsd]')).toHaveValue(
    '3',
  );

  await page.locator('tr:has-text("bob@walletofsatoshi.com") form[action="/recipients/delete"] button').click();
  await expect(page.locator('body')).not.toContainText('bob@walletofsatoshi.com');
  await page.locator('tr:has-text("alice@walletofsatoshi.com") form[action="/recipients/delete"] button').click();
  await expect(page.locator('body')).toContainText('No recipients');
});

test('public dashboard does not link to the editor', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).not.toContain('/login');
  expect(html).not.toContain('/recipients');
  expect(html).not.toContain('Log in');
});
