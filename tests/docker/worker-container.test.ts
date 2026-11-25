import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { SANDBOX_ON_NOTICE } from '../../apps/worker/src/sessions/sandbox.js';
import {
  AGENT_SESSION_CAPABILITY,
  WorkerListResponseSchema,
} from '../../packages/contracts/src/index.js';
import { BUILD_TIMEOUT_MS, prepareImage, startStack, stopAllStacks } from './support/stack.js';

const TEST_TIMEOUT_MS = 240_000;
const WAIT = { timeout: 60_000, interval: 250 };

// A cold image build can take longer than a test, so it gets its own timeout.
beforeAll(() => prepareImage(), BUILD_TIMEOUT_MS);

// Stops stacks that are still starting too, for example after a test timed out.
afterEach(() => stopAllStacks(), 60_000);
afterAll(() => stopAllStacks(), 60_000);

it(
  'registers the container Worker with the agent session capability',
  async () => {
    const stack = await startStack();
    const workers = WorkerListResponseSchema.parse(
      (await stack.api.inject('/api/v1/workers')).json<unknown>(),
    ).items;
    const worker = workers.find((item) => item.id === stack.workerId);
    expect(worker).toMatchObject({ availability: 'online', workspaceRoot: stack.workspace });
    expect(worker?.capabilities).toContain(AGENT_SESSION_CAPABILITY);
  },
  TEST_TIMEOUT_MS,
);

it(
  'runs a sandboxed session end to end and starts it again in the same worktree',
  async () => {
    const stack = await startStack();
    const { taskId } = await stack.createLocalTask('my project', 'Run the agent');
    const board = await stack.boardSocket(taskId);
    await expect.poll(() => board.session?.state, WAIT).toBe('none');

    board.send({ type: 'start', cols: 80, rows: 24 });
    await expect.poll(() => board.session?.state, WAIT).toBe('running');
    const worktreePath = board.session?.worktreePath;
    expect(board.session).toMatchObject({ branch: `atlas/task-${taskId}` });
    expect(worktreePath).toEqual(expect.stringContaining(stack.workspace));
    await expect.poll(() => board.output, WAIT).toContain(`READY ${worktreePath}`);
    expect(board.output.startsWith(SANDBOX_ON_NOTICE)).toBe(true);

    board.send({ type: 'input', data: 'ping\n' });
    await expect.poll(() => board.output, WAIT).toContain('ECHO ping');

    board.send({ type: 'stop' });
    await expect.poll(() => board.session?.state, WAIT).toBe('exited');

    const again = await stack.boardSocket(taskId);
    await expect.poll(() => again.session?.state, WAIT).toBe('exited');
    const restart = again.messages.length;
    again.send({ type: 'start', cols: 80, rows: 24 });
    await expect.poll(() => again.session?.state, WAIT).toBe('running');
    expect(again.session?.worktreePath).toBe(worktreePath);
    await expect.poll(() => again.outputFrom(restart), WAIT).toContain(`READY ${worktreePath}`);
    expect(again.outputFrom(restart).startsWith(SANDBOX_ON_NOTICE)).toBe(true);
    again.send({ type: 'input', data: 'again\n' });
    await expect.poll(() => again.outputFrom(restart), WAIT).toContain('ECHO again');

    again.send({ type: 'stop' });
    await expect.poll(() => again.session?.state, WAIT).toBe('exited');
  },
  TEST_TIMEOUT_MS,
);
