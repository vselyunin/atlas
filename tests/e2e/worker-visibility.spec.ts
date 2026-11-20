import { test, expect } from '@playwright/test';

test('worker availability and errors stay visible in the narrow header', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('1 worker online', { exact: true })).toBeInViewport();
  await page.route('**/api/v1/workers', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: 'Workers unavailable' } }),
    }),
  );
  await page.reload();
  await expect(page.getByText('Workers unavailable', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'User settings', exact: true })).toBeInViewport();
});
