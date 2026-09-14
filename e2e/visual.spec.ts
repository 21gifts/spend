import { expect, test } from '@playwright/test';

test.skip(process.platform !== 'linux', 'visual baselines are linux/chromium');

const SHOT = { animations: 'disabled' as const, caret: 'hide' as const, fullPage: true as const };

test('login', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText('500000 sats');
  await expect(page.locator('body')).toContainText('387.50 USD');
  await expect(page.locator('body')).toContainText('9643e3@lightning.space');
  await expect(page).toHaveScreenshot('login.png', SHOT);
});

test('login-error', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'nope');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.locator('body')).toContainText('Invalid password');
  await expect(page).toHaveScreenshot('login-error.png', SHOT);
});

test('recipients-one', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.locator('body')).toContainText('alice@w...');
  await expect(page.locator('body')).toContainText('500000 sats');
  await expect(page.locator('li.row.total .usd-total')).toHaveText('1');
  await expect(page).toHaveScreenshot('recipients-one.png', SHOT);
});

test('recipients-empty', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await page.locator('li.row:has(input[name="address"][value="alice@walletofsatoshi.com"]) form[action="/recipients/delete"] button').click();
  await expect(page.locator('body')).toContainText('No recipients');
  await expect(page).toHaveScreenshot('recipients-empty.png', SHOT);
});
