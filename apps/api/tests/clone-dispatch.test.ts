import {
  OperationResponseSchema,
  ProjectCreateResponseSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  GithubLinkResponseSchema,
} from '@atlas/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REPOSITORY, errorCode, resetStandIn, startCloneApi } from './support/clone-api.js';
import type { CloneApi } from './support/clone-api.js';
import { NO_CLONE_CAPABILITIES, connectWorker } from './support/fake-worker.js';
import type { FakeWorker } from './support/fake-worker.js';
import { startGithubStandIn } from './support/github-stand-in.js';
import type { GithubStandIn } from './support/github-stand-in.js';

let github: GithubStandIn;
let api: CloneApi;
const workers: FakeWorker[] = [];

beforeAll(async () => {
  github = await startGithubStandIn();
});
afterAll(async () => {
  await github.close();
});
beforeEach(async () => {
  resetStandIn(github);
  api = await startCloneApi(github);
}, 30_000);
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  await api.close();
});

async function worker(options: Parameters<typeof connectWorker>[1] = {}) {
  const connected = await connectWorker(api.app, options);
  workers.push(connected);
  return connected;
}

const clone = { mode: 'local', workerId: 'atlas:test', relativePath: 'repo' };

async function projectCount() {
  const list = await api.app.inject({ url: '/api/v1/projects', headers: { cookie: api.owner } });
  return ProjectListResponseSchema.parse(list.json<unknown>()).items.length;
}

// Waits until the API has noticed that a Worker's socket closed.
async function waitOffline(workerId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await api.app.inject({
      url: '/api/v1/workers',
      headers: { cookie: api.owner },
    });
    const { items } = response.json<{ items: Array<{ id: string; availability: string }> }>();
    if (items.find((item) => item.id === workerId)?.availability === 'offline') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The Worker did not go offline');
}

describe('creating a project by cloning', { timeout: 30_000 }, () => {
  it('refuses a Worker that cannot clone and writes nothing', async () => {
    await worker({ capabilities: NO_CLONE_CAPABILITIES });
    const response = await api.create({ ...clone, githubRepositoryId: REPOSITORY.id });
    expect(response.statusCode).toBe(503);
    expect(errorCode(response)).toBe('worker_unavailable');
    expect(await projectCount()).toBe(0);
  });

  it('dispatches a clone with the repository name and nothing else', async () => {
    const fake = await worker();
    const response = await api.create({ ...clone, githubRepositoryId: REPOSITORY.id });
    expect(response.statusCode).toBe(202);
    const { project, operation } = ProjectCreateResponseSchema.parse(response.json<unknown>());
    expect(project.repository).toEqual({
      mode: 'local',
      workerId: 'atlas:test',
      relativePath: 'repo',
      localPath: null,
    });
    expect(project.state).toBe('pending');

    const dispatch = await fake.next('command.dispatch');
    expect(dispatch.commandId).toBe(operation?.id);
    expect(dispatch.payload).toStrictEqual({
      kind: 'repository.clone',
      projectId: project.id,
      relativePath: 'repo',
      repository: REPOSITORY.fullName,
    });

    const link = await api.app.inject({
      url: `/api/v1/projects/${project.id}/github-link`,
      headers: { cookie: api.owner },
    });
    expect(GithubLinkResponseSchema.parse(link.json<unknown>()).link).toMatchObject({
      projectId: project.id,
      repositoryId: REPOSITORY.id,
      fullName: REPOSITORY.fullName,
      defaultBranch: REPOSITORY.defaultBranch,
    });
    // Creating a project never asks GitHub for a token with repository rights.
    const minted = github.state.requests.filter(
      (request) => request.method === 'POST' && JSON.stringify(request.body).includes('"contents"'),
    );
    expect(minted).toEqual([]);
  });

  it('refuses a repository the App cannot access and writes nothing', async () => {
    await worker();
    const response = await api.create({ ...clone, githubRepositoryId: 999 });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('repository_not_accessible');
    expect(await projectCount()).toBe(0);
  });

  it('answers 502 and writes nothing when GitHub fails', async () => {
    await worker();
    github.state.failWith = 500;
    const response = await api.create({ ...clone, githubRepositoryId: REPOSITORY.id });
    expect(response.statusCode).toBe(502);
    expect(errorCode(response)).toBe('github_unavailable');
    github.state.failWith = null;
    expect(await projectCount()).toBe(0);
  });

  it('still sends an init command for a new local repository', async () => {
    const fake = await worker();
    const response = await api.create(clone, 'Fresh');
    expect(response.statusCode).toBe(202);
    const { project } = ProjectCreateResponseSchema.parse(response.json<unknown>());
    const dispatch = await fake.next('command.dispatch');
    expect(dispatch.payload).toStrictEqual({
      kind: 'repository.init',
      projectId: project.id,
      relativePath: 'repo',
    });
  });

  it('keeps the operation shape and makes the project ready on success', async () => {
    const fake = await worker();
    const response = await api.create({ ...clone, githubRepositoryId: REPOSITORY.id });
    const { project, operation } = ProjectCreateResponseSchema.parse(response.json<unknown>());
    const dispatch = await fake.next('command.dispatch');

    const read = await api.app.inject({
      url: `/api/v1/operations/${operation?.id ?? ''}`,
      headers: { cookie: api.owner },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json<{ operation: Record<string, unknown> }>();
    expect(Object.keys(body.operation).sort()).toEqual([
      'connectionLost',
      'createdAt',
      'error',
      'id',
      'projectId',
      'result',
      'state',
      'updatedAt',
      'workerId',
    ]);
    OperationResponseSchema.parse(body);

    fake.send({ type: 'command.accepted', commandId: dispatch.commandId, payload: {} });
    fake.send({
      type: 'command.result',
      commandId: dispatch.commandId,
      payload: { status: 'succeeded', localPath: '/tmp/atlas-test/repo' },
    });
    await fake.next('command.result_ack');
    const after = await api.app.inject({
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie: api.owner },
    });
    const ready = ProjectResponseSchema.parse(after.json<unknown>()).project;
    expect(ready.state).toBe('ready');
    expect(Object.keys(after.json<{ project: object }>().project).sort()).toEqual(
      Object.keys(project).sort(),
    );
  });

  it('sends a pending clone again after the Worker reconnects', async () => {
    const first = await worker();
    await api.create({ ...clone, githubRepositoryId: REPOSITORY.id });
    const original = await first.next('command.dispatch');
    await first.close();
    await waitOffline('atlas:test');

    const second = await worker();
    const again = await second.next('command.dispatch');
    expect(again.commandId).toBe(original.commandId);
    expect(again.payload).toStrictEqual(original.payload);
  });

  it('does not send a clone to a Worker that came back without the capability', async () => {
    const first = await worker();
    await api.create({ ...clone, githubRepositoryId: REPOSITORY.id });
    await first.next('command.dispatch');
    await first.close();
    await waitOffline('atlas:test');

    const older = await worker({ capabilities: NO_CLONE_CAPABILITIES });
    await expect(older.next('command.dispatch', 300)).rejects.toThrow('No matching message');
  });
});
