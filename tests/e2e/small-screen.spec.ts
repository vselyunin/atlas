import { test, expect } from '@playwright/test';
test('keeps header controls reachable at 320 pixels without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'User settings', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.getByRole('button', { name: 'User settings', exact: true }).click();
  await expect(page.getByLabel('Appearance')).toBeInViewport();
});
