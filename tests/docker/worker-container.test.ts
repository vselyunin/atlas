import { afterEach, expect, it } from 'vitest';
import { SANDBOX_ON_NOTICE } from '../../apps/worker/src/sessions/sandbox.js';
import {
  AGENT_SESSION_CAPABILITY,
  WorkerListResponseSchema,
} from '../../packages/contracts/src/index.js';
import { startStack } from './support/stack.js';
import type { Stack } from './support/stack.js';

const TEST_TIMEOUT_MS = 240_000;
const WAIT = { timeout: 60_000, interval: 250 };

let stack: Stack | undefined;

afterEach(async () => {
  await stack?.stop();
  stack = undefined;
}, 60_000);

it(
  'registers the container Worker with the agent session capability',
  async () => {
    stack = await startStack();
    const workers = WorkerListResponseSchema.parse(
      (await stack.api.inject('/api/v1/workers')).json<unknown>(),
    ).items;
    expect(workers.find((worker) => worker.id === stack?.workerId)).toMatchObject({
      availability: 'online',
      workspaceRoot: stack.workspace,
    });
    expect(workers.find((worker) => worker.id === stack?.workerId)?.capabilities).toContain(
      AGENT_SESSION_CAPABILITY,
    );
  },
  TEST_TIMEOUT_MS,
);

it(
  'runs a sandboxed session end to end and starts it again in the same worktree',
  async () => {
    stack = await startStack();
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
