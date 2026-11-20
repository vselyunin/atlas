import { test, expect } from '@playwright/test';
import { stat } from 'node:fs/promises';
import { ProjectListResponseSchema } from '../../packages/contracts/src/index.js';

test('manage projects, versions, task fields, drag/drop and local repositories', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByText('1 worker online', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Atlas test project');
  await page.getByLabel('Git URL').fill('https://github.com/example/atlas.git');
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Backlog', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Ship the board');
  await page.getByLabel('Description', { exact: true }).fill('First useful version');
  await page.getByLabel('Type', { exact: true }).selectOption('story');
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await page.getByLabel('Responsible worker').selectOption('human:vladi');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ship the board', exact: true }).click();
  await page.getByLabel('Status', { exact: true }).selectOption('working');
  await expect(page.getByLabel('Title', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Description', { exact: true })).toBeEnabled();
  await page.getByLabel('Description', { exact: true }).fill('Work in progress');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  await page.getByLabel('Status', { exact: true }).selectOption('done');
  await expect(page.getByLabel('Description', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Status', { exact: true })).toBeEnabled();
  await page.getByLabel('Status', { exact: true }).selectOption('backlog');
  await expect(page.getByLabel('Title', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const handle = page.getByRole('button', { name: 'Move Ship the board', exact: true });
  const source = await handle.boundingBox();
  const target = await page.getByRole('region', { name: 'To do', exact: true }).boundingBox();
  if (!source || !target) throw new Error('Missing drag targets');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + 12, source.y + 12, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + 100, { steps: 20 });
  await page.mouse.up();
  await expect(
    page
      .getByRole('region', { name: 'To do', exact: true })
      .getByRole('button', { name: 'Ship the board', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'To do', exact: true })
      .getByRole('button', { name: 'Ship the board', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Version', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create version', exact: true }).click();
  await page.getByLabel('Version name').fill('v0.2');
  await page.getByRole('dialog').getByRole('button', { name: 'Add version', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ship the board', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create project', exact: true }).click();
  await page.getByLabel('Project name').fill('Local repository');
  await page.getByRole('button', { name: /New local repository/ }).click();
  await page.getByLabel('Folder path').fill('local-example');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Backlog', exact: true })).toBeVisible();
  const response = await request.get('/api/v1/projects');
  const body: unknown = await response.json();
  const local = ProjectListResponseSchema.parse(body).items.find(
    (project) => project.name === 'Local repository',
  );
  expect(local?.state).toBe('ready');
  if (local?.repository.mode !== 'local' || !local.repository.localPath)
    throw new Error('Missing local repository path');
  expect((await stat(`${local.repository.localPath}/.git`)).isDirectory()).toBe(true);
  await page.screenshot({ path: '.superpowers/atlas-board-verified.png', fullPage: true });
});
