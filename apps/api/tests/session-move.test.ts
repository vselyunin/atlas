import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  ProjectCreateResponseSchema,
  TaskResponseSchema,
  VersionListResponseSchema,
} from '@atlas/contracts';
import type { Task, TaskStatus } from '@atlas/contracts';
import { connectWorker } from './support/fake-worker.js';
import type { FakeWorker } from './support/fake-worker.js';
import { createApi, until } from './support/session-harness.js';
import type { BoardSocket } from './support/session-harness.js';

const OLD_CAPABILITIES = ['repository.init', 'agent.session', 'repository.clone'];

let api: Awaited<ReturnType<typeof createApi>>;
let worker: FakeWorker | undefined;
beforeEach(async () => {
  api = await createApi();
});
afterEach(async () => {
  await worker?.close();
  worker = undefined;
  await api.close();
});

// Connects the fake Worker and creates a local project on it with one task in To do.
async function setup(capabilities?: readonly string[]) {
  const connected = await connectWorker(api.app, capabilities ? { capabilities } : {});
  worker = connected;
  const created = ProjectCreateResponseSchema.parse(
    (
      await api.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: {
          name: 'Repo',
          repository: { mode: 'local', workerId: connected.workerId, relativePath: 'repo' },
        },
      })
    ).json<unknown>(),
  );
  const command = await connected.next('command.dispatch');
  connected.send({
    type: 'command.result',
    commandId: command.commandId,
    payload: { status: 'succeeded', localPath: '/tmp/atlas-test/repo' },
  });
  await connected.next('command.result_ack');
  const { items } = VersionListResponseSchema.parse(
    (await api.app.inject(`/api/v1/projects/${created.project.id}/versions`)).json<unknown>(),
  );
  const versionId = items[0]?.id ?? '';
  const addTask = async (title: string) => {
    const response = await api.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${created.project.id}/versions/${versionId}/tasks`,
      payload: { title, description: 'Details.', status: 'todo' },
    });
    return TaskResponseSchema.parse(response.json<unknown>()).task;
  };
  return { worker: connected, task: await addTask('Fix the login bug'), addTask };
}

async function move(task: Task, status: TaskStatus, beforeTaskId: string | null = null) {
  const response = await api.app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${task.id}/move`,
    payload: { expectedRevision: task.revision, status, beforeTaskId },
  });
  expect(response.statusCode).toBe(200);
  return TaskResponseSchema.parse(response.json<unknown>()).task;
}

async function expectNoStart(fake: FakeWorker) {
  await expect(fake.next('session.start', 300)).rejects.toThrow('No matching message');
}

const lastSession = (board: BoardSocket) =>
  board.messages.filter((message) => message.type === 'session').at(-1);

const waitForStatus = (board: BoardSocket, status: string) =>
  until(() => {
    const last = lastSession(board);
    return last?.status === status ? last : undefined;
  }, `${status} status`);

async function waitOffline(workerId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await api.app.inject('/api/v1/workers');
    const { items } = response.json<{ items: Array<{ id: string; availability: string }> }>();
    if (items.find((item) => item.id === workerId)?.availability === 'offline') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The Worker did not go offline');
}

it('starts one session with the default size when a task moves into Working', async () => {
  const { worker, task } = await setup();
  const moved = await move(task, 'working');
  expect(moved.status).toBe('working');
  const start = await worker.next('session.start');
  expect(start.payload).toMatchObject({ sessionId: task.id, cols: 120, rows: 30 });
  await expectNoStart(worker);
  const board = await api.board(task.id);
  const snapshot = await board.next('session');
  expect(snapshot).toMatchObject({ state: 'starting', status: 'working', reason: 'starting' });
  expect(typeof snapshot.since).toBe('string');
});

it('starts nothing when a task is reordered inside Working', async () => {
  const { worker, task, addTask } = await setup();
  const other = await move(await addTask('Second task'), 'working');
  await worker.next('session.start');
  const first = await move(task, 'working');
  await worker.next('session.start');
  const reordered = await move(first, 'working', other.id);
  expect(reordered.position).toBe(0);
  await expectNoStart(worker);
});

it('starts one session for a move and a Board start in the same tick', async () => {
  const { worker, task } = await setup();
  const board = await api.board(task.id);
  await board.next('session');
  const response = api.app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${task.id}/move`,
    payload: { expectedRevision: task.revision, status: 'working', beforeTaskId: null },
  });
  board.send({ type: 'start', cols: 80, rows: 24 });
  expect((await response).statusCode).toBe(200);
  await worker.next('session.start');
  await expectNoStart(worker);
  expect(board.messages.some((message) => message.type === 'error')).toBe(false);
});

it('records a start refused by an offline Worker and clears it when the task leaves', async () => {
  const { worker, task } = await setup();
  await worker.close();
  await waitOffline(worker.workerId);
  const moved = await move(task, 'working');
  const board = await api.board(task.id);
  const { since, ...refused } = await board.next('session');
  expect(refused).toEqual({
    type: 'session',
    state: 'none',
    branch: null,
    worktreePath: null,
    exitCode: null,
    message: 'The project worker is offline',
    status: 'problem',
    reason: 'not_started',
  });
  expect(typeof since).toBe('string');
  await move(moved, 'todo');
  expect(await waitForStatus(board, 'none')).toMatchObject({
    reason: 'none',
    message: null,
    since: null,
  });
  const later = await api.board(task.id);
  expect(await later.next('session')).toMatchObject({ status: 'none', reason: 'none' });
});

it('refuses a Worker too old to report session status', async () => {
  const { worker, task } = await setup(OLD_CAPABILITIES);
  await move(task, 'working');
  const board = await api.board(task.id);
  expect(await board.next('session')).toMatchObject({
    state: 'none',
    status: 'problem',
    reason: 'not_started',
    message: 'The project worker is too old to run agent sessions',
  });
  await expectNoStart(worker);
});

it('starts a new run when a task with an exited session moves back into Working', async () => {
  const { worker, task } = await setup();
  const board = await api.board(task.id);
  const working = await move(task, 'working');
  const first = await worker.next('session.start');
  worker.send({
    type: 'session.exit',
    payload: { sessionId: task.id, runId: first.payload.runId, exitCode: 0, message: null },
  });
  expect(await waitForStatus(board, 'ended')).toMatchObject({ state: 'exited', reason: 'exited' });
  const back = await move(working, 'todo');
  await expectNoStart(worker);
  await move(back, 'working');
  const second = await worker.next('session.start');
  expect(second.payload.runId).not.toBe(first.payload.runId);
});

it('ignores activity reported for another run', async () => {
  const { worker, task } = await setup();
  const board = await api.board(task.id);
  await move(task, 'working');
  const { runId } = (await worker.next('session.start')).payload;
  worker.send({
    type: 'session.started',
    payload: { sessionId: task.id, runId, branch: 'b', worktreePath: '/tmp/wt' },
  });
  const running = await until(() => {
    const last = lastSession(board);
    return last?.state === 'running' ? last : undefined;
  }, 'the running session');
  const seen = board.messages.length;
  const activity = (id: string, value: string) =>
    worker.send({
      type: 'session.activity',
      payload: { sessionId: task.id, runId: id, activity: value, detail: null },
    });
  activity('other-run', 'needs_input');
  activity(runId, 'idle');
  const finished = await waitForStatus(board, 'finished');
  expect(board.messages.slice(seen)).toEqual([finished]);
  expect(finished).toMatchObject({ state: 'running', reason: 'finished' });
  expect(running).toMatchObject({ status: 'working', reason: 'working' });
});
