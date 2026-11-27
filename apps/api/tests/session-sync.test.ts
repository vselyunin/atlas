import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectCreateResponseSchema,
  SessionListResponseSchema,
  TaskResponseSchema,
  VersionListResponseSchema,
  versionSessionsPath,
} from '@atlas/contracts';
import type { Task, TaskStatus } from '@atlas/contracts';
import { TEST_APP_SECRETS, buildAuthApp } from './support/auth-app.js';
import { connectWorker } from './support/fake-worker.js';
import type { FakeWorker } from './support/fake-worker.js';
import { createApi, until } from './support/session-harness.js';
import type { BoardSocket } from './support/session-harness.js';

const OLD_CAPABILITIES = ['repository.init', 'agent.session', 'repository.clone'];
const LOST = 'The Worker restarted and the session was lost';

let api: Awaited<ReturnType<typeof createApi>>;
let worker: FakeWorker;
let projectId: string;
let versionId: string;

beforeEach(async () => {
  api = await createApi();
  worker = await connectWorker(api.app);
  const created = ProjectCreateResponseSchema.parse(
    (
      await api.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: {
          name: 'Repo',
          repository: { mode: 'local', workerId: worker.workerId, relativePath: 'repo' },
        },
      })
    ).json<unknown>(),
  );
  projectId = created.project.id;
  const command = await worker.next('command.dispatch');
  worker.send({
    type: 'command.result',
    commandId: command.commandId,
    payload: { status: 'succeeded', localPath: '/tmp/atlas-test/repo' },
  });
  await worker.next('command.result_ack');
  const { items } = VersionListResponseSchema.parse(
    (await api.app.inject(`/api/v1/projects/${projectId}/versions`)).json<unknown>(),
  );
  versionId = items[0]?.id ?? '';
});
afterEach(async () => {
  await worker.close();
  await api.close();
});

async function addTask(title = 'Fix the login bug') {
  const response = await api.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/versions/${versionId}/tasks`,
    payload: { title, description: 'Details.', status: 'todo' },
  });
  return TaskResponseSchema.parse(response.json<unknown>()).task;
}

async function move(task: Task, status: TaskStatus) {
  const response = await api.app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${task.id}/move`,
    payload: { expectedRevision: task.revision, status, beforeTaskId: null },
  });
  expect(response.statusCode).toBe(200);
  return TaskResponseSchema.parse(response.json<unknown>()).task;
}

// Moves a new task into Working and reports its session as running.
async function runningTask(title?: string) {
  const task = await addTask(title);
  await move(task, 'working');
  const { runId } = (await worker.next('session.start')).payload;
  worker.send({
    type: 'session.started',
    payload: { sessionId: task.id, runId, branch: `atlas/task-${task.id}`, worktreePath: '/wt' },
  });
  return { task, runId };
}

// Answered with an error after every earlier frame on this socket was handled.
async function settle(fake = worker) {
  fake.send({ type: 'worker.heartbeat', payload: { workerId: 'atlas:someone-else' } });
  await fake.next('protocol.error');
}

async function waitOffline() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await api.app.inject('/api/v1/workers');
    const { items } = response.json<{ items: Array<{ id: string; availability: string }> }>();
    if (items.find((item) => item.id === worker.workerId)?.availability === 'offline') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The Worker did not go offline');
}

async function reconnect(capabilities?: readonly string[]) {
  await worker.close();
  await waitOffline();
  worker = await connectWorker(api.app, capabilities ? { capabilities } : {});
}

function sync(sessions: unknown[] = [], exits: unknown[] = []) {
  worker.send({ type: 'session.sync', payload: { sessions, exits } });
}

const listed = (sessionId: string, runId: string, fields: Record<string, unknown> = {}) => ({
  sessionId,
  runId,
  state: 'running',
  worktreePath: '/wt',
  branch: 'b',
  activity: null,
  detail: null,
  ...fields,
});

const lastSession = (board: BoardSocket) =>
  board.messages.filter((message) => message.type === 'session').at(-1);

const waitForReason = (board: BoardSocket, reason: string) =>
  until(() => {
    const last = lastSession(board);
    return last?.reason === reason ? last : undefined;
  }, `the ${reason} reason`);

async function list() {
  const response = await api.app.inject(versionSessionsPath(projectId, versionId));
  expect(response.statusCode).toBe(200);
  return SessionListResponseSchema.parse(response.json<unknown>()).items;
}

it('ends a running session the sync does not list as lost', async () => {
  const { task } = await runningTask();
  const board = await api.board(task.id);
  await reconnect();
  sync();
  expect(await waitForReason(board, 'worker_lost')).toEqual({
    type: 'session',
    state: 'exited',
    branch: `atlas/task-${task.id}`,
    worktreePath: '/wt',
    exitCode: null,
    message: LOST,
    status: 'problem',
    reason: 'worker_lost',
    since: expect.any(String) as string,
  });
  expect(await list()).toEqual([
    {
      taskId: task.id,
      status: 'problem',
      reason: 'worker_lost',
      message: LOST,
      exitCode: null,
      since: expect.any(String) as string,
    },
  ]);
});

it('keeps a session the sync lists and applies its activity', async () => {
  const { task, runId } = await runningTask();
  const board = await api.board(task.id);
  await reconnect();
  sync([listed(task.id, runId, { activity: 'idle' })]);
  expect(await waitForReason(board, 'finished')).toMatchObject({
    state: 'running',
    status: 'finished',
    branch: `atlas/task-${task.id}`,
  });
});

it('shows the summary message of an API error on the Board socket', async () => {
  const { task, runId } = await runningTask();
  const board = await api.board(task.id);
  await reconnect();
  sync([listed(task.id, runId, { activity: 'error', detail: 'rate_limit' })]);
  expect(await waitForReason(board, 'api_error')).toMatchObject({
    status: 'problem',
    message: 'rate_limit',
    exitCode: null,
  });
});

it('takes the running state and the Worker run of a session still starting', async () => {
  const task = await addTask();
  await move(task, 'working');
  await worker.next('session.start');
  const board = await api.board(task.id);
  await reconnect();
  const runId = randomUUID();
  sync([listed(task.id, runId, { worktreePath: '/wt2', branch: 'b2' })]);
  expect(await waitForReason(board, 'working')).toMatchObject({
    state: 'running',
    worktreePath: '/wt2',
    branch: 'b2',
  });
  worker.send({
    type: 'session.activity',
    payload: { sessionId: task.id, runId, activity: 'idle', detail: null },
  });
  await waitForReason(board, 'finished');
});

it('leaves a session started after the registration alone', async () => {
  const { task: before } = await runningTask('Before');
  await reconnect();
  const after = await addTask('After');
  await move(after, 'working');
  await worker.next('session.start');
  sync();
  const board = await api.board(before.id);
  await waitForReason(board, 'worker_lost');
  expect(await list()).toEqual([
    expect.objectContaining({ taskId: before.id, status: 'problem', reason: 'worker_lost' }),
    expect.objectContaining({ taskId: after.id, status: 'working', reason: 'starting' }),
  ]);
});

it('shows an exit carried in the sync as ended, not lost', async () => {
  const { task, runId } = await runningTask();
  const board = await api.board(task.id);
  await reconnect();
  sync([], [{ sessionId: task.id, runId, exitCode: 0, message: 'Done' }]);
  expect(await waitForReason(board, 'exited')).toMatchObject({
    state: 'exited',
    status: 'ended',
    exitCode: 0,
    message: 'Done',
  });
  await settle();
  expect(board.messages.some((m) => m.type === 'session' && m.reason === 'worker_lost')).toBe(
    false,
  );
});

it('does not revive a lost session on a late start report', async () => {
  const { task, runId } = await runningTask();
  const board = await api.board(task.id);
  await reconnect();
  sync();
  await waitForReason(board, 'worker_lost');
  worker.send({
    type: 'session.started',
    payload: { sessionId: task.id, runId, branch: 'b', worktreePath: '/wt' },
  });
  sync([listed(task.id, runId)]);
  await settle();
  expect(lastSession(board)).toMatchObject({ state: 'exited', reason: 'worker_lost' });
  expect(await list()).toEqual([expect.objectContaining({ reason: 'worker_lost' })]);
});

it('adopts a listed session it does not know for an existing task', async () => {
  const task = await addTask();
  const runId = randomUUID();
  sync([
    listed(randomUUID(), randomUUID()),
    listed(task.id, runId, { activity: 'needs_input', detail: 'asked_in_text' }),
  ]);
  await settle();
  expect(await list()).toEqual([
    {
      taskId: task.id,
      status: 'needs_input',
      reason: 'asked_in_text',
      message: null,
      exitCode: null,
      since: expect.any(String) as string,
    },
  ]);
  const board = await api.board(task.id);
  expect(await board.next('session')).toMatchObject({
    state: 'running',
    worktreePath: '/wt',
    branch: 'b',
  });
  board.send({ type: 'input', data: 'yes\r' });
  expect((await worker.next('session.input')).payload).toEqual({
    sessionId: task.id,
    runId,
    data: 'yes\r',
  });
});

it('replaces an ended session with a different live run the Worker lists', async () => {
  const { task, runId } = await runningTask();
  worker.send({
    type: 'session.exit',
    payload: { sessionId: task.id, runId, exitCode: 0, message: null },
  });
  await settle();
  const board = await api.board(task.id);
  await waitForReason(board, 'exited');
  sync([listed(task.id, randomUUID(), { activity: 'working' })]);
  expect(await waitForReason(board, 'working')).toMatchObject({ state: 'running' });
});

it('ignores a listed session of a task whose project is on another Worker', async () => {
  const task = await addTask();
  const stranger = await connectWorker(api.app, { workerId: 'atlas:stranger' });
  try {
    stranger.send({
      type: 'session.sync',
      payload: { sessions: [listed(task.id, randomUUID())], exits: [] },
    });
    await settle(stranger);
    expect(await list()).toEqual([]);
  } finally {
    await stranger.close();
  }
});

it('shows a disconnected Worker as offline until it reconnects and syncs', async () => {
  const { task, runId } = await runningTask();
  worker.send({
    type: 'session.activity',
    payload: { sessionId: task.id, runId, activity: 'idle', detail: null },
  });
  const board = await api.board(task.id);
  await waitForReason(board, 'finished');
  await worker.close();
  expect(await waitForReason(board, 'worker_offline')).toMatchObject({
    state: 'running',
    status: 'problem',
  });
  expect(await list()).toEqual([
    expect.objectContaining({ taskId: task.id, status: 'problem', reason: 'worker_offline' }),
  ]);
  await waitOffline();
  worker = await connectWorker(api.app);
  sync([listed(task.id, runId, { activity: 'idle' })]);
  await waitForReason(board, 'finished');
  expect(await list()).toEqual([
    expect.objectContaining({ taskId: task.id, status: 'finished', reason: 'finished' }),
  ]);
});

it('keeps the sessions of a reconnected Worker that does not sync', async () => {
  const { task } = await runningTask();
  const board = await api.board(task.id);
  await reconnect(OLD_CAPABILITIES);
  expect(await waitForReason(board, 'working')).toMatchObject({ state: 'running' });
  await settle();
  expect(await list()).toEqual([expect.objectContaining({ status: 'working' })]);
});

describe('the session list route', () => {
  it('lists only tasks that have a status', async () => {
    const { task } = await runningTask();
    await addTask('Idle task');
    expect((await list()).map((item) => item.taskId)).toEqual([task.id]);
  });

  it('answers 404 for an unknown version', async () => {
    const response = await api.app.inject(versionSessionsPath(projectId, randomUUID()));
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'version_not_found' } });
  });

  it('needs a session when sign-in is on', async () => {
    const auth = await buildAuthApp();
    try {
      await writeFile(auth.appFile, JSON.stringify(TEST_APP_SECRETS), { mode: 0o600 });
      const response = await auth.app.inject(versionSessionsPath(projectId, versionId));
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'sign_in_required' } });
    } finally {
      await auth.close();
    }
  });
});
