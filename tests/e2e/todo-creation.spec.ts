import { test, expect } from '@playwright/test';
import {
  ProjectCreateResponseSchema,
  VersionListResponseSchema,
  TaskListResponseSchema,
  TaskResponseSchema,
  VersionResponseSchema,
} from '../../packages/contracts/src/index.js';

test('creates and edits To do tasks, keeps empty actions compact and preserves version ordering', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/v1/projects', {
    data: {
      name: 'To do creation',
      repository: { mode: 'existing', gitUrl: 'https://example.com/todo.git' },
    },
  });
  const body: unknown = await response.json();
  const project = ProjectCreateResponseSchema.parse(body).project;
  const versions = await request.get(`/api/v1/projects/${project.id}/versions`);
  const versionBody: unknown = await versions.json();
  const version = VersionListResponseSchema.parse(versionBody).items[0];
  if (!version) throw new Error('Missing version');
  const path = `/api/v1/projects/${project.id}/versions/${version.id}/tasks`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitemradio', { name: project.name, exact: true }).click();
  const todo = page.locator('[data-column="todo"]');
  const backlog = page.locator('[data-column="backlog"]');
  await expect(todo.getByRole('button', { name: 'Add task', exact: true })).toBeVisible();
  await expect(backlog.getByRole('button', { name: 'Add task', exact: true })).toBeVisible();
  await expect(page.locator('.column-empty')).toHaveCount(0);
  await todo.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Direct To do');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(todo.getByRole('button', { name: 'Direct To do', exact: true })).toBeVisible();
  await expect(todo.getByRole('button', { name: 'Add task', exact: true })).toHaveCount(0);
  await expect(todo.getByRole('button', { name: 'Add task to To do' })).toBeVisible();
  await todo.getByRole('button', { name: 'Direct To do', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Edited To do');
  await page.getByLabel('Type', { exact: true }).selectOption('epic');
  await page.getByLabel('Priority', { exact: true }).selectOption('urgent');
  await page.getByLabel('Responsible worker').selectOption('human:vladi');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const tasksResponse = await request.get(path);
  const tasksBody: unknown = await tasksResponse.json();
  const task = TaskListResponseSchema.parse(tasksBody).items[0];
  expect(task).toMatchObject({
    title: 'Edited To do',
    status: 'todo',
    type: 'epic',
    priority: 'urgent',
    assigneeId: 'human:vladi',
  });
  if (!task) throw new Error('Missing task');
  await request.post(path, { data: { title: 'Remaining', status: 'todo' } });
  const newVersionResponse = await request.post(`/api/v1/projects/${project.id}/versions`, {
    data: { name: 'v0.2' },
  });
  const newVersionBody: unknown = await newVersionResponse.json();
  const nextVersion = VersionResponseSchema.parse(newVersionBody).version;
  const nextPath = `/api/v1/projects/${project.id}/versions/${nextVersion.id}/tasks`;
  await request.post(nextPath, { data: { title: 'Already there', status: 'todo' } });
  const relocatedResponse = await request.patch(`/api/v1/tasks/${task.id}`, {
    data: { expectedRevision: task.revision, changes: { versionId: nextVersion.id } },
  });
  expect(relocatedResponse.status()).toBe(200);
  const relocatedBody: unknown = await relocatedResponse.json();
  expect(TaskResponseSchema.parse(relocatedBody).task).toMatchObject({
    status: 'todo',
    position: 1,
  });
  const remainingResponse = await request.get(path);
  const remainingBody: unknown = await remainingResponse.json();
  expect(TaskListResponseSchema.parse(remainingBody).items).toMatchObject([
    { title: 'Remaining', position: 0 },
  ]);
  for (const status of ['working', 'done']) {
    expect(
      (await request.post(path, { data: { title: 'Invalid destination', status } })).status(),
    ).toBe(400);
  }
});
