import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MAX_SESSION_PROMPT_CHARS } from '@atlas/contracts';
import { BOARD_ORIGIN, createApi, until } from './support/session-harness.js';
import type { BoardSocket, WorkerSocket } from './support/session-harness.js';

const CAPABILITIES = [
  'repository.init',
  'agent.session',
  'repository.clone',
  'agent.session.status',
];
const WORKER = 'atlas:test';

let api: Awaited<ReturnType<typeof createApi>>;
beforeEach(async () => {
  api = await createApi();
});
afterEach(async () => {
  await api.close();
});

async function setup(capabilities = CAPABILITIES) {
  const worker = await api.registerWorker(WORKER, capabilities);
  const { taskId } = await api.localTask(WORKER);
  const board = await api.board(taskId);
  await board.next('session');
  return { worker, taskId, board };
}

async function startRun(worker: WorkerSocket, board: BoardSocket) {
  board.send({ type: 'start', cols: 100, rows: 30 });
  const start = await worker.received('session.start');
  return start.payload;
}

const workerMessage = (
  worker: WorkerSocket,
  type: string,
  taskId: string,
  runId: string,
  fields: Record<string, unknown>,
) => worker.send(type, { sessionId: taskId, runId, ...fields });

const sessionStates = (board: BoardSocket) =>
  board.messages.flatMap((m) => (m.type === 'session' ? [m.state] : []));

const waitForState = (board: BoardSocket, state: string, count = 1) =>
  until(
    () => (sessionStates(board).filter((s) => s === state).length >= count ? true : undefined),
    `${state} state`,
  );

async function expectError(board: BoardSocket, message: string) {
  expect(await board.next('error')).toEqual({ type: 'error', message });
}

it('sends the current empty session when the Board connects', async () => {
  const { board } = await setup();
  expect(board.messages).toEqual([
    {
      type: 'session',
      state: 'none',
      branch: null,
      worktreePath: null,
      exitCode: null,
      message: null,
      status: 'none',
      reason: 'none',
      since: null,
    },
  ]);
});

it('starts a session on the project worker with the task as the prompt', async () => {
  const { worker, taskId, board } = await setup();
  const payload = await startRun(worker, board);
  expect(payload).toMatchObject({
    sessionId: taskId,
    relativePath: 'repo',
    cols: 100,
    rows: 30,
    prompt: 'Task: Fix the login bug\n\nIt fails on Safari.',
  });
  expect(payload.runId).toBeTruthy();
  expect(await board.next('session')).toMatchObject({ state: 'starting' });
});

it('limits the prompt to the maximum length', async () => {
  const { worker, taskId, board } = await setup();
  const response = await api.app.inject({
    method: 'PATCH',
    url: `/api/v1/tasks/${taskId}`,
    payload: {
      expectedRevision: 1,
      changes: { title: 'T'.repeat(200), description: 'd'.repeat(100_000) },
    },
  });
  expect(response.statusCode).toBe(200);
  const payload = await startRun(worker, board);
  expect(payload.prompt).toHaveLength(MAX_SESSION_PROMPT_CHARS);
  expect(payload.prompt.startsWith(`Task: ${'T'.repeat(200)}\n\ndd`)).toBe(true);
});

it('reports a task that does not exist', async () => {
  await api.registerWorker(WORKER, CAPABILITIES);
  const board = await api.board(randomUUID());
  board.send({ type: 'start', cols: 80, rows: 24 });
  await expectError(board, 'Task was not found');
});

it('reports a project without a checkout on a worker', async () => {
  const { taskId } = await api.existingRepoTask();
  const board = await api.board(taskId);
  board.send({ type: 'start', cols: 80, rows: 24 });
  await expectError(
    board,
    'This project has no checkout on a worker, so a session cannot start here',
  );
});

it('reports a worker that cannot run agent sessions', async () => {
  const { worker, board } = await setup(['repository.init']);
  board.send({ type: 'start', cols: 80, rows: 24 });
  await expectError(board, 'The project worker is too old to run agent sessions');
  expect(worker.messages.some((m) => m.type === 'session.start')).toBe(false);
});

it('reports an offline worker', async () => {
  const { worker, board } = await setup();
  worker.socket.close();
  // The API notices the closed connection asynchronously, so ask again until it does.
  await until(() => {
    board.send({ type: 'start', cols: 80, rows: 24 });
    return board.messages.some(
      (m) => m.type === 'error' && m.message === 'The project worker is offline',
    )
      ? true
      : undefined;
  }, 'the offline error');
  expect(board.messages.find((m) => m.type === 'error')).toEqual({
    type: 'error',
    message: 'The project worker is offline',
  });
});

it('follows the Worker through started, output and exit', async () => {
  const { worker, taskId, board } = await setup();
  const { runId } = await startRun(worker, board);
  await waitForState(board, 'starting');
  workerMessage(worker, 'session.started', taskId, runId, {
    branch: `atlas/task-${taskId}`,
    worktreePath: '/tmp/wt',
  });
  await waitForState(board, 'running');
  expect(board.messages.at(-1)).toEqual({
    type: 'session',
    state: 'running',
    branch: `atlas/task-${taskId}`,
    worktreePath: '/tmp/wt',
    exitCode: null,
    message: null,
    status: 'working',
    reason: 'working',
    since: expect.any(String) as string,
  });
  workerMessage(worker, 'session.output', taskId, runId, { data: 'hello' });
  expect(await board.next('output')).toEqual({ type: 'output', data: 'hello' });
  workerMessage(worker, 'session.exit', taskId, runId, { exitCode: 3, message: null });
  await waitForState(board, 'exited');
  expect(board.messages.at(-1)).toMatchObject({ state: 'exited', exitCode: 3 });
});

it('ignores a wrong runId and another worker', async () => {
  const { worker, taskId, board } = await setup();
  const stranger = await api.registerWorker('atlas:stranger', CAPABILITIES);
  const { runId } = await startRun(worker, board);
  await waitForState(board, 'starting');
  const started = { branch: 'b', worktreePath: '/tmp/wt' };
  workerMessage(worker, 'session.started', taskId, 'other-run', started);
  workerMessage(worker, 'session.output', taskId, 'other-run', { data: 'wrong run' });
  workerMessage(worker, 'session.exit', taskId, 'other-run', { exitCode: 1, message: null });
  workerMessage(stranger, 'session.started', taskId, runId, started);
  workerMessage(stranger, 'session.output', taskId, runId, { data: 'wrong worker' });
  workerMessage(stranger, 'session.exit', taskId, runId, { exitCode: 1, message: null });
  // Frames on one socket are handled in order. A heartbeat claiming another identity is
  // answered with an error, which shows the stranger's earlier frames were already handled.
  stranger.send('worker.heartbeat', { workerId: WORKER });
  await stranger.received('protocol.error');
  workerMessage(worker, 'session.output', taskId, runId, { data: 'real' });
  await board.next('output');
  expect(board.messages.slice(1)).toEqual([
    expect.objectContaining({ type: 'session', state: 'starting' }),
    { type: 'output', data: 'real' },
  ]);
});

it('starts a new run after an exit and ignores a late exit from the old run', async () => {
  const { worker, taskId, board } = await setup();
  const first = await startRun(worker, board);
  workerMessage(worker, 'session.exit', taskId, first.runId, { exitCode: 0, message: null });
  await waitForState(board, 'exited');
  const second = await startRun(worker, board);
  expect(second.runId).not.toBe(first.runId);
  await waitForState(board, 'starting', 2);
  workerMessage(worker, 'session.exit', taskId, first.runId, { exitCode: 9, message: 'late' });
  workerMessage(worker, 'session.started', taskId, second.runId, {
    branch: 'b',
    worktreePath: '/tmp/wt',
  });
  await waitForState(board, 'running');
  expect(sessionStates(board)).toEqual(['none', 'starting', 'exited', 'starting', 'running']);
});

it('replays the current session and output to a Board that attaches mid-run', async () => {
  const { worker, taskId, board } = await setup();
  const { runId } = await startRun(worker, board);
  workerMessage(worker, 'session.started', taskId, runId, { branch: 'b', worktreePath: '/tmp/wt' });
  workerMessage(worker, 'session.output', taskId, runId, { data: 'one ' });
  workerMessage(worker, 'session.output', taskId, runId, { data: 'two' });
  await until(
    () => (board.messages.filter((m) => m.type === 'output').length === 2 ? true : undefined),
    'live output',
  );
  const late = await api.board(taskId);
  await late.next('output');
  expect(late.messages).toEqual([
    {
      type: 'session',
      state: 'running',
      branch: 'b',
      worktreePath: '/tmp/wt',
      exitCode: null,
      message: null,
      status: 'working',
      reason: 'working',
      since: expect.any(String) as string,
    },
    { type: 'output', data: 'one two' },
  ]);
});

it('keeps at most 400,000 characters of replay, ending with the latest output', async () => {
  const { worker, taskId, board } = await setup();
  const { runId } = await startRun(worker, board);
  for (let index = 0; index < 50; index++) {
    workerMessage(worker, 'session.output', taskId, runId, {
      data: String(index % 10).repeat(16_000),
    });
  }
  await until(
    () => (board.messages.filter((m) => m.type === 'output').length === 50 ? true : undefined),
    'all output',
  );
  const late = await api.board(taskId);
  const replay = await late.next('output');
  expect(replay.data.length).toBeLessThanOrEqual(400_000);
  expect(replay.data.length).toBeGreaterThan(300_000);
  expect(replay.data.endsWith('9'.repeat(16_000))).toBe(true);
});

it('forwards input, resize and stop with the current runId', async () => {
  const { worker, taskId, board } = await setup();
  const { runId } = await startRun(worker, board);
  board.send({ type: 'input', data: 'ls\r' });
  board.send({ type: 'resize', cols: 120, rows: 40 });
  board.send({ type: 'stop' });
  expect((await worker.received('session.input')).payload).toEqual({
    sessionId: taskId,
    runId,
    data: 'ls\r',
  });
  expect((await worker.received('session.resize')).payload).toEqual({
    sessionId: taskId,
    runId,
    cols: 120,
    rows: 40,
  });
  expect((await worker.received('session.stop')).payload).toEqual({ sessionId: taskId, runId });
});

it('ignores input, resize and stop when there is no live session', async () => {
  const { worker, taskId, board } = await setup();
  const sendAll = () => {
    board.send({ type: 'input', data: 'x' });
    board.send({ type: 'resize', cols: 90, rows: 20 });
    board.send({ type: 'stop' });
  };
  sendAll();
  const { runId } = await startRun(worker, board);
  workerMessage(worker, 'session.exit', taskId, runId, { exitCode: 0, message: null });
  await waitForState(board, 'exited');
  sendAll();
  // The next start is handled after the ignored messages, so none of them were forwarded.
  await startRun(worker, board);
  expect(worker.messages.map((m) => m.type).filter((t) => t.startsWith('session.'))).toEqual([
    'session.start',
    'session.start',
  ]);
  expect(board.messages.some((m) => m.type === 'error')).toBe(false);
});

it('refuses a socket without the Board origin', async () => {
  const { taskId } = await setup();
  await expect(api.board(taskId, null)).rejects.toThrow('403');
  await expect(api.board(taskId, 'http://evil.example')).rejects.toThrow('403');
  await expect(api.board(taskId, BOARD_ORIGIN)).resolves.toBeDefined();
});

it('answers a non-JSON frame and an unknown message with an error and stays open', async () => {
  const { board } = await setup();
  board.send('not json');
  await expectError(board, 'Expected a JSON message');
  board.send({ type: 'reboot' });
  await until(
    () => (board.messages.filter((m) => m.type === 'error').length === 2 ? true : undefined),
    'second error',
  );
  expect(board.messages.at(-1)).toEqual({ type: 'error', message: 'Invalid message' });
  expect(board.socket.readyState).toBe(board.socket.OPEN);
});
