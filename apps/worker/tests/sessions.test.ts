import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_SESSION_OUTPUT_CHARS } from '@atlas/contracts';
import { createHarness, startPayload } from './support/sessions.js';
import type { Harness } from './support/sessions.js';

const run = promisify(execFile);

let harness: Harness | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await harness?.cleanup();
  harness = undefined;
});

async function setup(options?: Parameters<typeof createHarness>[0]) {
  harness = await createHarness(options);
  return harness;
}

describe('sessions with a stand-in agent', () => {
  it('starts in the worktree and reports it', async () => {
    const h = await setup();
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app', { prompt: 'do the thing' });

    await h.manager.start(payload);

    const started = await h.waitFor('session.started', payload.sessionId);
    expect(started.payload).toMatchObject({
      sessionId: payload.sessionId,
      runId: payload.runId,
      worktreePath: `${h.root}/.atlas-worktrees/app/${payload.sessionId}`,
      branch: `atlas/task-${payload.sessionId}`,
    });
    const worktreePath = 'worktreePath' in started.payload ? started.payload.worktreePath : '';
    await h.waitForOutput(payload.sessionId, `READY ${worktreePath}`);
  });

  it('does not pass the prompt to a custom agent', async () => {
    const h = await setup();
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app', { prompt: 'secret-prompt-text' });

    await h.manager.start(payload);
    await h.waitForOutput(payload.sessionId, 'ARGS []');

    expect(h.output(payload.sessionId)).not.toContain('secret-prompt-text');
  });

  it('delivers input to the agent', async () => {
    const h = await setup();
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    await h.manager.start(payload);
    await h.waitForOutput(payload.sessionId, 'READY');

    h.manager.input(payload.sessionId, payload.runId, 'hello\n');

    await h.waitForOutput(payload.sessionId, 'ECHO hello');
  });

  it('hides Atlas settings from the agent and confines Git to the workspace', async () => {
    vi.stubEnv('ATLAS_WORKER_TOKEN', 'must-not-leak');
    vi.stubEnv('ATLAS_SOMETHING_ELSE', 'nor-this');
    const h = await setup();
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    await h.manager.start(payload);
    await h.waitForOutput(payload.sessionId, 'READY');

    h.manager.input(payload.sessionId, payload.runId, 'env\n');
    await h.waitForOutput(payload.sessionId, 'ENV [');

    const line = h
      .output(payload.sessionId)
      .split(/\r?\n/)
      .find((text) => text.startsWith('ENV '));
    const names = JSON.parse(line?.slice(4) ?? '[]') as string[];
    expect(names.filter((name) => name.startsWith('ATLAS_'))).toEqual([]);
    expect(names).toContain('GIT_CEILING_DIRECTORIES');
  });

  it('starts two tasks begun in the same tick in a new empty repository', async () => {
    const h = await setup();
    const repo = await h.initRepository('fresh');
    const first = startPayload(randomUUID(), 'fresh');
    const second = startPayload(randomUUID(), 'fresh');

    await Promise.all([h.manager.start(first), h.manager.start(second)]);

    await h.waitFor('session.started', first.sessionId);
    await h.waitFor('session.started', second.sessionId);
    const log = (await run('git', ['log', '--oneline', '--all'], { cwd: repo })).stdout.trim();
    expect(log.split('\n')).toHaveLength(1);
    expect(log).toMatch(/ chore: initial commit$/);
  });

  it('reports a stop that arrives before the session started', async () => {
    const h = await setup();
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');

    const starting = h.manager.start(payload);
    h.manager.stop(payload.sessionId, payload.runId);
    await starting;

    const exit = await h.waitFor('session.exit', payload.sessionId);
    expect(exit.payload).toMatchObject({
      runId: payload.runId,
      exitCode: null,
      message: 'The session was stopped before it started',
    });
    expect(h.events.some((event) => event.type === 'session.started')).toBe(false);
    expect(h.output(payload.sessionId)).not.toContain('READY');
  });

  it('starts nothing after stopAll during preparation', async () => {
    const h = await setup({ agentArgs: ['--slow-start', '500'] });
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');

    const starting = h.manager.start(payload);
    h.manager.stopAll();
    await starting;
    await h.waitFor('session.exit', payload.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(h.events.map((event) => event.type)).toEqual(['session.exit']);
  });

  it('kills an agent that ignores the hangup after the grace period', async () => {
    const h = await setup({ agentArgs: ['--ignore-hup'], stopGraceMs: 200 });
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    await h.manager.start(payload);
    await h.waitForOutput(payload.sessionId, 'READY');

    const stoppedAt = Date.now();
    h.manager.stop(payload.sessionId, payload.runId);

    const exit = await h.waitFor('session.exit', payload.sessionId);
    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
    expect(exit.payload).toMatchObject({ runId: payload.runId, message: null });
  });

  it('re-attaches a running session under a new run id', async () => {
    const h = await setup();
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    await h.manager.start(payload);
    await h.waitForOutput(payload.sessionId, 'READY');
    const newRunId = randomUUID();

    await h.manager.start({ ...payload, runId: newRunId });

    const started = h.events.filter((event) => event.type === 'session.started');
    expect(started).toHaveLength(2);
    expect(started[1]?.payload).toMatchObject({
      sessionId: payload.sessionId,
      runId: newRunId,
      worktreePath:
        started[0] && 'worktreePath' in started[0].payload ? started[0].payload.worktreePath : '',
    });
    const before = h.events.length;
    h.manager.input(payload.sessionId, newRunId, 'again\n');
    await h.waitForOutput(payload.sessionId, 'ECHO again');
    const later = h.events.slice(before).filter((event) => event.type === 'session.output');
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((event) => event.payload.runId === newRunId)).toBe(true);
  });

  it('reports input and stop for an unknown session', async () => {
    const h = await setup();
    const sessionId = randomUUID();
    const inputRun = randomUUID();
    const stopRun = randomUUID();

    h.manager.input(sessionId, inputRun, 'hello\n');
    h.manager.stop(sessionId, stopRun);

    expect(h.events).toEqual([
      {
        type: 'session.exit',
        payload: {
          sessionId,
          runId: inputRun,
          exitCode: null,
          message: 'The session is no longer running',
        },
      },
      {
        type: 'session.exit',
        payload: {
          sessionId,
          runId: stopRun,
          exitCode: null,
          message: 'The session is no longer running',
        },
      },
    ]);
  });

  it('reports the exit code of the agent', async () => {
    const h = await setup();
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    await h.manager.start(payload);
    await h.waitForOutput(payload.sessionId, 'READY');

    h.manager.input(payload.sessionId, payload.runId, 'exit 3\n');

    const exit = await h.waitFor('session.exit', payload.sessionId);
    expect(exit.payload).toEqual({
      sessionId: payload.sessionId,
      runId: payload.runId,
      exitCode: 3,
      message: null,
    });
  });

  it('streams a large burst of output without loss, within the chunk limit', async () => {
    const h = await setup();
    await h.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    await h.manager.start(payload);
    await h.waitForOutput(payload.sessionId, 'READY');

    // Terminal lines are limited in length, so send many lines in one write.
    const line = 'x'.repeat(900);
    const lines = 60;
    h.manager.input(payload.sessionId, payload.runId, `${`${line}\n`.repeat(lines)}`);
    await vi.waitFor(
      () => {
        expect(h.output(payload.sessionId).split(`ECHO ${line}`).length - 1).toBe(lines);
      },
      { timeout: 10_000 },
    );

    const chunks = h.events.flatMap((event) =>
      event.type === 'session.output' ? [event.payload.data.length] : [],
    );
    expect(Math.max(...chunks)).toBeLessThanOrEqual(MAX_SESSION_OUTPUT_CHARS);
    expect(chunks.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(MAX_SESSION_OUTPUT_CHARS);
  });
});
