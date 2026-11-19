import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProjectCreateResponseSchema,
  VersionListResponseSchema,
  TaskResponseSchema,
  TaskListResponseSchema,
  WorkerListResponseSchema,
  VersionResponseSchema,
} from '@atlas/contracts';
import type { Task, TaskStatus } from '@atlas/contracts';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atlas-api-'));
  app = await buildApp({
    dbPath: join(directory, 'db.sqlite'),
    workerToken: 'test-token',
    allowedOrigin: 'http://localhost:5173',
  });
});
afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
async function project(name = 'Example') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: {
      name,
      repository: { mode: 'existing', gitUrl: 'https://github.com/example/example.git' },
    },
  });
  expect(res.statusCode).toBe(201);
  const { project } = ProjectCreateResponseSchema.parse(res.json<unknown>());
  const versions = VersionListResponseSchema.parse(
    (await app.inject(`/api/v1/projects/${project.id}/versions`)).json<unknown>(),
  ).items;
  const version = versions[0];
  if (!version) throw new Error('Missing initial version');
  return { project, version, path: `/api/v1/projects/${project.id}/versions/${version.id}/tasks` };
}
async function move(task: Task, status: TaskStatus) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${task.id}/move`,
    payload: { expectedRevision: task.revision, status, beforeTaskId: null },
  });
  expect(res.statusCode).toBe(200);
  return TaskResponseSchema.parse(res.json<unknown>()).task;
}
async function task(path: string, title = 'First task') {
  return TaskResponseSchema.parse(
    (await app.inject({ method: 'POST', url: path, payload: { title } })).json<unknown>(),
  ).task;
}
describe('workspace resources', () => {
  it('persists a project and seeds v0.1 and only one human across restart', async () => {
    const { project: created, version } = await project();
    expect(version.name).toBe('v0.1');
    await app.close();
    app = await buildApp({
      dbPath: join(directory, 'db.sqlite'),
      workerToken: 'test-token',
      allowedOrigin: 'http://localhost:5173',
    });
    expect((await app.inject(`/api/v1/projects/${created.id}`)).statusCode).toBe(200);
    expect(
      WorkerListResponseSchema.parse((await app.inject('/api/v1/workers')).json<unknown>()).items,
    ).toMatchObject([{ id: 'human:vladi', kind: 'human', name: 'Vladi' }]);
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${created.id}/versions`,
      payload: { name: 'v0.1' },
    });
    expect(duplicate.statusCode).toBe(409);
  });
  it('rejects a foreign browser Origin and unavailable local worker', async () => {
    const hostile = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { origin: 'https://unrelated.example' },
      payload: { name: 'x', repository: { mode: 'existing', gitUrl: 'https://example.com/r.git' } },
    });
    expect(hostile.statusCode).toBe(403);
    const local = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: {
        name: 'x',
        repository: { mode: 'local', workerId: 'missing', relativePath: 'new' },
      },
    });
    expect(local.statusCode).toBe(503);
  });
});
describe('task rules', () => {
  it('creates only in Backlog with independent type and priority', async () => {
    const { path } = await project();
    expect(await task(path)).toMatchObject({
      status: 'backlog',
      type: 'task',
      priority: 'medium',
      assigneeId: null,
    });
    expect(
      (await app.inject({ method: 'POST', url: path, payload: { title: 'Skip', status: 'done' } }))
        .statusCode,
    ).toBe(400);
  });
  it.each(['backlog', 'todo', 'working', 'done'] as const)(
    'enforces fields in %s and permits a return to Backlog',
    async (status) => {
      const { path } = await project();
      let current = await move(await task(path), status);
      const forbidden = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${current.id}`,
        payload: {
          expectedRevision: current.revision,
          changes: { description: 'Changed', priority: 'high' },
        },
      });
      expect(forbidden.statusCode).toBe(status === 'backlog' ? 200 : 403);
      if (status === 'backlog') current = TaskResponseSchema.parse(forbidden.json<unknown>()).task;
      const description = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${current.id}`,
        payload: {
          expectedRevision: current.revision,
          changes: { description: 'Only description' },
        },
      });
      expect(description.statusCode).toBe(status === 'done' ? 403 : 200);
      if (status !== 'done') current = TaskResponseSchema.parse(description.json<unknown>()).task;
      current = await move(current, 'backlog');
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/tasks/${current.id}`,
            payload: {
              expectedRevision: current.revision,
              changes: {
                title: 'Unlocked',
                assigneeId: 'human:vladi',
                type: 'epic',
                priority: 'urgent',
              },
            },
          })
        ).statusCode,
      ).toBe(200);
    },
  );
  it('rejects stale revision and cross-project version atomically', async () => {
    const a = await project('A');
    const b = await project('B');
    const current = await task(a.path);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/tasks/${current.id}`,
          payload: {
            expectedRevision: current.revision,
            changes: { title: 'Bad move', versionId: b.version.id },
          },
        })
      ).statusCode,
    ).toBe(404);
    await move(current, 'working');
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/tasks/${current.id}`,
          payload: { expectedRevision: current.revision, changes: { description: 'stale' } },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      TaskListResponseSchema.parse((await app.inject(a.path)).json<unknown>()).items[0]?.title,
    ).toBe('First task');
  });
  it('persists ordering and permits a Backlog version change', async () => {
    const { project: p, path } = await project();
    const first = await task(path, 'First');
    const second = await task(path, 'Second');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${second.id}/move`,
      payload: { expectedRevision: second.revision, status: 'backlog', beforeTaskId: first.id },
    });
    expect(response.statusCode).toBe(200);
    expect(
      TaskListResponseSchema.parse((await app.inject(path)).json<unknown>()).items.map(
        (item) => item.title,
      ),
    ).toEqual(['Second', 'First']);
    const added = VersionResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/projects/${p.id}/versions`,
          payload: { name: 'v0.2' },
        })
      ).json<unknown>(),
    ).version;
    const updated = TaskResponseSchema.parse(response.json<unknown>()).task;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/tasks/${second.id}`,
          payload: { expectedRevision: updated.revision, changes: { versionId: added.id } },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      TaskListResponseSchema.parse((await app.inject(path)).json<unknown>()).items.map(
        (item) => item.title,
      ),
    ).toEqual(['First']);
  });
});
