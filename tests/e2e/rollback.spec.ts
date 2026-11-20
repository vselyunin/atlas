import { test, expect } from '@playwright/test';
import {
  ProjectCreateResponseSchema,
  VersionListResponseSchema,
} from '../../packages/contracts/src/index.js';
test('a rejected move restores the card to its original column', async ({ page, request }) => {
  const createdResponse = await request.post('/api/v1/projects', {
    data: {
      name: 'Rollback checks',
      repository: { mode: 'existing', gitUrl: 'https://example.com/rollback.git' },
    },
  });
  const createdBody: unknown = await createdResponse.json();
  const project = ProjectCreateResponseSchema.parse(createdBody).project;
  const versionResponse = await request.get(`/api/v1/projects/${project.id}/versions`);
  const versionBody: unknown = await versionResponse.json();
  const version = VersionListResponseSchema.parse(versionBody).items[0];
  if (!version) throw new Error('Missing initial version');
  const taskResponse = await request.post(
    `/api/v1/projects/${project.id}/versions/${version.id}/tasks`,
    { data: { title: 'Rollback example' } },
  );
  expect(taskResponse.status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Rollback checks', exact: true }).click();
  await page.getByRole('button', { name: 'Rollback example', exact: true }).click();
  await page.route('**/api/v1/tasks/*/move', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'revision_conflict', message: 'Task changed elsewhere' },
      }),
    });
  });
  await page.getByLabel('Status', { exact: true }).selectOption('working');
  await expect(
    page.getByText('Move failed: Task changed elsewhere Your board has been restored.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('backlog');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Backlog', exact: true })
      .getByRole('button', { name: 'Rollback example', exact: true }),
  ).toBeVisible();
});
