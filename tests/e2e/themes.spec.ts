import { test, expect } from '@playwright/test';

test('system theme, saved overrides and portal controls work in both themes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'User settings', exact: true }).click();
  await expect(page.getByLabel('Appearance')).toHaveValue('system');
  await expect(page.getByRole('dialog', { name: 'User settings' })).toHaveCSS(
    'background-color',
    'rgb(32, 32, 32)',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('dialog', { name: 'User settings' })).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  await page.getByLabel('Appearance').selectOption('dark');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'User settings', exact: true }).click();
  await expect(page.getByLabel('Appearance')).toHaveValue('dark');
  await page.getByLabel('Appearance').selectOption('system');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'User settings', exact: true })).toBeFocused();
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.getByRole('button', { name: 'Project', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Create project', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Create project' })).toBeVisible();
    await expect(page.getByLabel('Project name')).toBeFocused();
    await page.screenshot({ path: `.superpowers/themes-${theme}-dialog.png`, fullPage: true });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeFocused();
  }
});

test('unavailable storage does not block startup or theme switching', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('Storage blocked');
      },
    });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'User settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeVisible();
});

test('compact board and long menu names remain usable at narrow widths', async ({
  page,
  request,
}) => {
  const name = 'A project with a deliberately long name for responsive header checks';
  const response = await request.post('/api/v1/projects', {
    data: {
      name,
      repository: { mode: 'existing', gitUrl: 'https://example.com/theme-layout.git' },
    },
  });
  expect(response.status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('A task in both themes');
  await page.getByLabel('Type', { exact: true }).selectOption('epic');
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('button', { name: 'A task in both themes', exact: true }) });
  await expect(card.locator('.card-footer')).toContainText('Epic');
  await expect(card.locator('.card-footer')).toContainText('High');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeInViewport();
      await expect(
        page.getByRole('button', { name: 'User settings', exact: true }),
      ).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `.superpowers/themes-${theme}-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Project', exact: true }).click();
      await expect(page.getByRole('menuitemradio', { name, exact: true })).toBeInViewport();
      await page.keyboard.press('Escape');
    }
  }
  const board = page.locator('.board-grid');
  expect(await board.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});
