import { test, expect } from '@playwright/test';
import {
  ProjectCreateResponseSchema,
  VersionListResponseSchema,
} from '../../packages/contracts/src/index.js';

test('a rejected keyboard move restores focus to the original card', async ({ page, request }) => {
  const created = await request.post('/api/v1/projects', {
    data: {
      name: 'Keyboard rollback',
      repository: { mode: 'existing', gitUrl: 'https://example.com/keyboard.git' },
    },
  });
  const body: unknown = await created.json();
  const project = ProjectCreateResponseSchema.parse(body).project;
  const versions = await request.get(`/api/v1/projects/${project.id}/versions`);
  const versionBody: unknown = await versions.json();
  const version = VersionListResponseSchema.parse(versionBody).items[0];
  if (!version) throw new Error('Missing version');
  await request.post(`/api/v1/projects/${project.id}/versions/${version.id}/tasks`, {
    data: { title: 'Keyboard card' },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Keyboard rollback', exact: true }).click();
  let rejectMove: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    rejectMove = resolve;
  });
  await page.route('**/api/v1/tasks/*/move', async (route) => {
    await gate;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'revision_conflict', message: 'Task changed elsewhere' },
      }),
    });
  });
  const card = page.getByRole('button', { name: 'Keyboard card', exact: true });
  await card.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(page.locator('[data-column="todo"] .task-title')).toHaveText(['Keyboard card']);
  await expect(card).toBeFocused();
  rejectMove?.();
  await expect(page.locator('[data-column="backlog"] .task-title')).toHaveText(['Keyboard card']);
  await expect(card).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
});
