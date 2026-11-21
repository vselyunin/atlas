import { test, expect } from '@playwright/test';
import {
  ProjectCreateResponseSchema,
  VersionListResponseSchema,
} from '../../packages/contracts/src/index.js';

test('whole cards open, drag into exact positions, persist order and support keyboard moves', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/v1/projects', {
    data: {
      name: 'Card ordering',
      repository: { mode: 'existing', gitUrl: 'https://example.com/cards.git' },
    },
  });
  const body: unknown = await response.json();
  const project = ProjectCreateResponseSchema.parse(body).project;
  const versions = await request.get(`/api/v1/projects/${project.id}/versions`);
  const versionBody: unknown = await versions.json();
  const version = VersionListResponseSchema.parse(versionBody).items[0];
  if (!version) throw new Error('Missing version');
  for (const title of ['Alpha', 'Beta', 'Gamma']) {
    const created = await request.post(
      `/api/v1/projects/${project.id}/versions/${version.id}/tasks`,
      { data: { title } },
    );
    expect(created.status()).toBe(201);
  }
  await page.goto('/');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Card ordering', exact: true }).click();
  const backlog = page.locator('[data-column="backlog"]');
  const gamma = page.getByRole('button', { name: 'Gamma', exact: true });
  await gamma.getByText('Medium', { exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const source = await gamma.boundingBox();
  const beta = await page.getByRole('button', { name: 'Beta', exact: true }).boundingBox();
  if (!source || !beta) throw new Error('Missing cards');
  await page.mouse.move(source.x + 20, source.y + source.height - 15);
  await page.mouse.down();
  await page.mouse.move(source.x + 30, source.y + source.height - 15, { steps: 3 });
  await page.mouse.move(beta.x + 40, beta.y + 8, { steps: 15 });
  await expect(backlog.getByTestId('drop-indicator')).toBeVisible();
  await expect(backlog.locator('.drop-indicator + article .task-title')).toHaveText('Beta');
  const savedPointerMove = page.waitForResponse(
    (response) =>
      response.url().endsWith('/move') && response.request().method() === 'POST' && response.ok(),
  );
  await page.mouse.up();
  await savedPointerMove;
  await expect(backlog.locator('.task-title')).toHaveText(['Alpha', 'Gamma', 'Beta']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Card ordering', exact: true }).click();
  await expect(backlog.locator('.task-title')).toHaveText(['Alpha', 'Gamma', 'Beta']);
  await gamma.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  const savedKeyboardMove = page.waitForResponse(
    (response) =>
      response.url().endsWith('/move') && response.request().method() === 'POST' && response.ok(),
  );
  await page.keyboard.press('Space');
  await savedKeyboardMove;
  await expect(page.locator('[data-column="todo"] .task-title')).toHaveText(['Gamma']);
  await expect(gamma).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-column="todo"] .task-title')).toHaveText(['Gamma']);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Card ordering', exact: true }).click();
  await expect(page.locator('[data-column="todo"] .task-title')).toHaveText(['Gamma']);
});
