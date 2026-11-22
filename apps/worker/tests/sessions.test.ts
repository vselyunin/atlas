import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MAX_SESSION_OUTPUT_CHARS } from '@atlas/contracts';
import type { SessionStartPayload } from '@atlas/contracts';
import { SANDBOX_OFF_NOTICE, SANDBOX_ON_NOTICE } from '../src/sessions/sandbox.js';
import { writeFakeSrt } from './support/sandbox.js';
import type { FakeSrtMode } from './support/sandbox.js';
import { createHarness, startPayload } from './support/sessions.js';
import type { Harness, HarnessOptions } from './support/sessions.js';

const run = promisify(execFile);
const agentPath = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));

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

describe('sessions in the agent sandbox', () => {
  let bin: string | undefined;

  afterEach(async () => {
    if (bin) await rm(bin, { recursive: true, force: true });
    bin = undefined;
  });

  async function setupWithSrt(mode: FakeSrtMode, options: HarnessOptions = {}) {
    bin = await realpath(await mkdtemp(join(tmpdir(), 'atlas-fake-srt-')));
    const srt = await writeFakeSrt(bin, mode);
    const h = await setup({ sandbox: 'required', pathPrefix: bin, ...options });
    await h.initRepository('app');
    return { h, srt };
  }

  const outputs = (h: Harness) =>
    h.events.flatMap((event) => (event.type === 'session.output' ? [event.payload.data] : []));

  it('starts the agent through srt and says the sandbox is on first', async () => {
    const { h, srt } = await setupWithSrt('exec');
    const payload = startPayload(randomUUID(), 'app', { prompt: 'do the thing' });

    await h.manager.start(payload);
    await h.waitForOutput(payload.sessionId, 'READY');
    await h.waitForOutput(payload.sessionId, 'ARGS []');

    expect(h.events[0]?.type).toBe('session.started');
    expect(outputs(h)[0]).toBe(SANDBOX_ON_NOTICE);
    const settingsPath = join(h.stateDir, 'sessions', `${payload.sessionId}.json`);
    expect(await srt.calls()).toEqual([
      ['--settings', settingsPath, '--', 'test', '!', '-e', settingsPath],
      ['--settings', settingsPath, '--', process.execPath, agentPath],
    ]);
  });

  it('does not start the agent when the sandbox does not hide the Worker state', async () => {
    const { h, srt } = await setupWithSrt('unsandboxed');
    const payload = startPayload(randomUUID(), 'app');

    await h.manager.start(payload);

    const exit = await h.waitFor('session.exit', payload.sessionId);
    expect(exit.payload).toMatchObject({
      exitCode: null,
      message:
        'The agent sandbox could not start, so the agent was not started: the sandbox did not hide the Worker state folder',
    });
    expect(h.events.map((event) => event.type)).toEqual(['session.exit']);
    expect(await srt.calls()).toHaveLength(1);
  });

  it('does not start the agent when the sandbox cannot start', async () => {
    const { h } = await setupWithSrt('fail');
    const payload = startPayload(randomUUID(), 'app');

    await h.manager.start(payload);

    const exit = await h.waitFor('session.exit', payload.sessionId);
    expect(exit.payload).toEqual({
      sessionId: payload.sessionId,
      runId: payload.runId,
      exitCode: null,
      message: 'The agent sandbox could not start, so the agent was not started: bwrap: nope',
    });
    expect(h.events.map((event) => event.type)).toEqual(['session.exit']);
    expect(h.output(payload.sessionId)).not.toContain('READY');
  });

  it('says the sandbox is off and does not use srt when it is off', async () => {
    const { h, srt } = await setupWithSrt('exec', { sandbox: 'off' });
    const payload = startPayload(randomUUID(), 'app');

    await h.manager.start(payload);
    await h.waitForOutput(payload.sessionId, 'READY');

    expect(outputs(h)[0]).toBe(SANDBOX_OFF_NOTICE);
    expect(await srt.calls()).toEqual([]);
  });

  for (const [name, stop] of [
    [
      'stop',
      (h: Harness, payload: SessionStartPayload) =>
        h.manager.stop(payload.sessionId, payload.runId),
    ],
    ['stopAll()', (h: Harness) => h.manager.stopAll()],
  ] as const) {
    it(`starts nothing after ${name} during the sandbox check`, async () => {
      const { h, srt } = await setupWithSrt('slow');
      const payload = startPayload(randomUUID(), 'app');

      const starting = h.manager.start(payload);
      await vi.waitFor(
        async () => {
          expect(await srt.checkStarted()).toBe(true);
        },
        { timeout: 10_000, interval: 20 },
      );
      stop(h, payload);
      await starting;

      const exit = await h.waitFor('session.exit', payload.sessionId);
      expect(exit.payload).toMatchObject({
        runId: payload.runId,
        exitCode: null,
        message: 'The session was stopped before it started',
      });
      expect(h.events.map((event) => event.type)).toEqual(['session.exit']);
      expect(await srt.calls()).toHaveLength(1);
    });
  }
});
