import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { WorkerToApiMessageSchema } from '@atlas/contracts';
import type { SessionStartPayload, WorkerToApiMessage } from '@atlas/contracts';
import { prepareConfig } from '../src/config.js';
import { startWorker } from '../src/main.js';
import { SessionManager } from '../src/sessions/manager.js';
import type { SessionEvent } from '../src/sessions/manager.js';
import { RUN_NOTICES, readRecord, writeRecord } from '../src/sessions/record.js';
import { sessionKey } from '../src/sessions/worktree.js';
import { writeFakeSrt } from './support/sandbox.js';
import { startPayload } from './support/sessions.js';

const run = promisify(execFile);
const agentPath = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));
const TIMEOUT = { timeout: 10_000, interval: 20 };

let directory: string | undefined;
let manager: SessionManager | undefined;
const events: SessionEvent[] = [];

afterEach(async () => {
  manager?.stopAll();
  const started = new Set(events.flatMap((e) => (e.type === 'session.started' ? [e] : [])));
  for (const event of started) {
    const { sessionId } = event.payload;
    await vi.waitFor(
      () =>
        expect(
          events.some((e) => e.type === 'session.exit' && e.payload.sessionId === sessionId),
        ).toBe(true),
      TIMEOUT,
    );
  }
  manager = undefined;
  events.length = 0;
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

interface Setup {
  home: string;
  stateDir: string;
  manager: SessionManager;
}

// A stand-in agent named `claude` or `codex`, so the Worker uses that agent's profile. It prints
// its arguments as `ARGS [...]`.
async function setup(
  name: 'claude' | 'codex',
  sandbox: 'required' | 'off' = 'off',
): Promise<Setup> {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-runs-')));
  const bin = join(directory, 'bin');
  const home = join(directory, 'home');
  await mkdir(bin);
  await mkdir(home);
  await writeFakeSrt(bin, 'exec');
  const agent = join(bin, name);
  await writeFile(agent, `#!/bin/sh\nexec '${process.execPath}' '${agentPath}' "$@"\n`, {
    mode: 0o755,
  });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  const config = prepareConfig({
    apiUrl: 'ws://127.0.0.1:1/api/v1/workers/connect',
    token: 'test-token',
    id: 'atlas:test',
    name: 'Test worker',
    root: join(directory, 'repos'),
    stateDir: join(directory, 'state'),
    agent: { command: [agent], sandbox },
  });
  const repo = join(config.root, 'app');
  await mkdir(repo, { recursive: true });
  await run('git', ['init', '--quiet', '-b', 'main'], { cwd: repo });
  manager = new SessionManager(config, (event) => events.push(event), {
    home,
    statusPollMs: 20,
  });
  return { home, stateDir: config.stateDir, manager };
}

const ofRun = (runId: string) => events.filter((event) => event.payload.runId === runId);

const output = (runId: string) =>
  ofRun(runId)
    .flatMap((event) => (event.type === 'session.output' ? [event.payload.data] : []))
    .join('');

async function argsOf(runId: string): Promise<string[]> {
  let line: string | undefined;
  await vi.waitFor(() => {
    line = output(runId)
      .split(/\r?\n/)
      .find((text) => text.startsWith('ARGS '));
    expect(line).toBeDefined();
  }, TIMEOUT);
  return JSON.parse(line?.slice(5) ?? '[]') as string[];
}

async function exitOf(runId: string) {
  await vi.waitFor(
    () => expect(ofRun(runId).some((event) => event.type === 'session.exit')).toBe(true),
    TIMEOUT,
  );
  return ofRun(runId).find((event) => event.type === 'session.exit');
}

// Starts a run, waits for its arguments and lets it exit.
async function runOnce(s: Setup, payload: SessionStartPayload): Promise<string[]> {
  await s.manager.start(payload);
  const args = await argsOf(payload.runId);
  s.manager.input(payload.sessionId, payload.runId, 'exit 0\n');
  await exitOf(payload.runId);
  return args;
}

async function addConversation(home: string, agentSessionId: string) {
  const project = join(home, '.claude', 'projects', '-some-project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${agentSessionId}.jsonl`), '{}\n');
}

const activities = (runId: string) =>
  ofRun(runId).flatMap((event) =>
    event.type === 'session.activity'
      ? [{ activity: event.payload.activity, detail: event.payload.detail }]
      : [],
  );

// The status file named in the hook settings Claude was given.
function statusFile(args: string[]): string {
  const settings = JSON.parse(args[args.lastIndexOf('--settings') + 1] ?? '{}') as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  const command = settings.hooks.Stop?.[0]?.hooks[0]?.command ?? '';
  return /'([^']+)'$/.exec(command)?.[1] ?? '';
}

describe('Claude runs', () => {
  it('sends the prompt on the first run with a new session id', async () => {
    const s = await setup('claude');
    const payload = startPayload(randomUUID(), 'app', { prompt: 'do the task' });

    const args = await runOnce(s, payload);

    const record = await readRecord(s.stateDir, sessionKey(payload.sessionId));
    expect(record).toMatchObject({ delivered: false });
    expect(args.slice(-3)).toEqual(['--session-id', record?.agentSessionId, 'do the task']);
    expect(output(payload.runId)).toContain(RUN_NOTICES.first);
    expect(activities(payload.runId)).toEqual([]);
    expect(JSON.stringify(record)).not.toContain('do the task');
  });

  it('resumes without the prompt when the conversation exists', async () => {
    const s = await setup('claude');
    const sessionId = randomUUID();
    await runOnce(s, startPayload(sessionId, 'app', { prompt: 'do the task' }));
    const first = await readRecord(s.stateDir, sessionKey(sessionId));
    await addConversation(s.home, first?.agentSessionId ?? '');
    const second = startPayload(sessionId, 'app', { prompt: 'do the task' });

    const args = await runOnce(s, second);

    expect(args).not.toContain('do the task');
    expect(args.slice(-2)).toEqual(['--resume', first?.agentSessionId]);
    expect(output(second.runId)).toContain(RUN_NOTICES.resume);
    expect(activities(second.runId)).toEqual([{ activity: 'idle', detail: 'resumed' }]);
    expect(await readRecord(s.stateDir, sessionKey(sessionId))).toEqual({
      agentSessionId: first?.agentSessionId,
      delivered: true,
    });
  });

  it('marks the prompt delivered when the conversation exists at exit', async () => {
    const s = await setup('claude');
    const payload = startPayload(randomUUID(), 'app', { prompt: 'do the task' });
    await s.manager.start(payload);
    await argsOf(payload.runId);
    const record = await readRecord(s.stateDir, sessionKey(payload.sessionId));
    await addConversation(s.home, record?.agentSessionId ?? '');

    s.manager.input(payload.sessionId, payload.runId, 'exit 0\n');
    await exitOf(payload.runId);

    expect(await readRecord(s.stateDir, sessionKey(payload.sessionId))).toEqual({
      agentSessionId: record?.agentSessionId,
      delivered: true,
    });
  });

  it('sends the prompt again when it was never delivered', async () => {
    const s = await setup('claude');
    const sessionId = randomUUID();
    await runOnce(s, startPayload(sessionId, 'app', { prompt: 'do the task' }));
    const first = await readRecord(s.stateDir, sessionKey(sessionId));
    const second = startPayload(sessionId, 'app', { prompt: 'do the task' });

    const args = await runOnce(s, second);

    const record = await readRecord(s.stateDir, sessionKey(sessionId));
    expect(record?.agentSessionId).not.toBe(first?.agentSessionId);
    expect(args.slice(-3)).toEqual(['--session-id', record?.agentSessionId, 'do the task']);
    expect(output(second.runId)).toContain(RUN_NOTICES.first);
  });

  it('starts fresh without the prompt when a delivered conversation is gone', async () => {
    const s = await setup('claude');
    const sessionId = randomUUID();
    const gone = randomUUID();
    await writeRecord(s.stateDir, sessionKey(sessionId), { agentSessionId: gone, delivered: true });
    const payload = startPayload(sessionId, 'app', { prompt: 'do the task' });

    const args = await runOnce(s, payload);

    const record = await readRecord(s.stateDir, sessionKey(sessionId));
    expect(record).toMatchObject({ delivered: true });
    expect(record?.agentSessionId).not.toBe(gone);
    expect(args).not.toContain('do the task');
    expect(args.slice(-2)).toEqual(['--session-id', record?.agentSessionId]);
    expect(output(payload.runId)).toContain(RUN_NOTICES.fresh);
    expect(activities(payload.runId)).toEqual([{ activity: 'idle', detail: 'resumed' }]);
  });

  it('reports lines of the status file as activity', async () => {
    const s = await setup('claude');
    const payload = startPayload(randomUUID(), 'app');
    await s.manager.start(payload);
    const file = statusFile(await argsOf(payload.runId));
    expect(file).not.toBe('');
    expect(await readFile(file, 'utf8')).toBe('');

    await appendFile(file, 'working -\n');
    await vi.waitFor(
      () => expect(activities(payload.runId)).toEqual([{ activity: 'working', detail: null }]),
      TIMEOUT,
    );
    // The same activity again is not reported twice.
    await appendFile(file, 'working -\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendFile(file, 'needs_input asked_in_text\n');
    await vi.waitFor(
      () =>
        expect(activities(payload.runId)).toEqual([
          { activity: 'working', detail: null },
          { activity: 'needs_input', detail: 'asked_in_text' },
        ]),
      TIMEOUT,
    );
    const started = ofRun(payload.runId).find((event) => event.type === 'session.started');
    expect(s.manager.snapshot()).toEqual([
      {
        sessionId: payload.sessionId,
        runId: payload.runId,
        state: 'running',
        worktreePath:
          started && 'worktreePath' in started.payload ? started.payload.worktreePath : '',
        branch: `atlas/task-${payload.sessionId}`,
        activity: 'needs_input',
        detail: 'asked_in_text',
      },
    ]);

    s.manager.input(payload.sessionId, payload.runId, 'exit 0\n');
    await exitOf(payload.runId);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks the worktree trusted only in the sandbox', async () => {
    for (const sandbox of ['off', 'required'] as const) {
      const s = await setup('claude', sandbox);
      const config = join(s.home, '.claude.json');
      const original = '{"projects":{},"other":1}';
      await writeFile(config, original);
      const payload = startPayload(randomUUID(), 'app');

      await s.manager.start(payload);
      const args = await argsOf(payload.runId);

      const started = ofRun(payload.runId).find((event) => event.type === 'session.started');
      const path = started && 'worktreePath' in started.payload ? started.payload.worktreePath : '';
      const after = await readFile(config, 'utf8');
      if (sandbox === 'off') expect(after).toBe(original);
      else {
        expect(JSON.parse(after)).toEqual({
          projects: { [path]: { hasTrustDialogAccepted: true } },
          other: 1,
        });
        // The agent may write its own status folder in the sandbox.
        const settings = JSON.parse(
          await readFile(join(s.stateDir, 'sessions', `${payload.sessionId}.json`), 'utf8'),
        ) as { filesystem: { allowWrite: string[] } };
        expect(settings.filesystem.allowWrite).toContain(dirname(statusFile(args)));
      }
      s.manager.stopAll();
      await exitOf(payload.runId);
      manager = undefined;
      events.length = 0;
      vi.unstubAllEnvs();
      await rm(directory ?? '', { recursive: true, force: true });
    }
  });
});

describe('Codex runs', () => {
  it('sends the prompt once and then starts without it', async () => {
    const s = await setup('codex');
    const sessionId = randomUUID();
    const first = startPayload(sessionId, 'app', { prompt: 'do the task' });

    expect(await runOnce(s, first)).toEqual(['do the task']);
    expect(await readRecord(s.stateDir, sessionKey(sessionId))).toMatchObject({ delivered: true });
    expect(output(first.runId)).toContain(RUN_NOTICES.first);

    // A conversation file under the recorded id does not matter for Codex.
    const record = await readRecord(s.stateDir, sessionKey(sessionId));
    await addConversation(s.home, record?.agentSessionId ?? '');
    const second = startPayload(sessionId, 'app', { prompt: 'do the task' });
    expect(await runOnce(s, second)).toEqual([]);
    expect(output(second.runId)).toContain(RUN_NOTICES.fresh);
    expect(activities(second.runId)).toEqual([{ activity: 'idle', detail: 'resumed' }]);
  });
});

describe('session lifecycle', () => {
  it('says the user stopped the session', async () => {
    const s = await setup('codex');
    const payload = startPayload(randomUUID(), 'app');
    await s.manager.start(payload);
    await argsOf(payload.runId);

    s.manager.stop(payload.sessionId, payload.runId);

    expect((await exitOf(payload.runId))?.payload).toMatchObject({ stopped: true });
  });

  it('omits stopped when the agent exits by itself', async () => {
    const s = await setup('codex');
    const payload = startPayload(randomUUID(), 'app');
    await runOnce(s, payload);

    expect((await exitOf(payload.runId))?.payload).not.toHaveProperty('stopped');
  });

  it('lists a session that is still starting', async () => {
    const s = await setup('codex');
    const payload = startPayload(randomUUID(), 'app');

    const starting = s.manager.start(payload);

    expect(s.manager.snapshot()).toEqual([
      {
        sessionId: payload.sessionId,
        runId: payload.runId,
        state: 'starting',
        worktreePath: null,
        branch: null,
        activity: null,
        detail: null,
      },
    ]);
    await starting;
  });

  it('emits the notices in order after the start', async () => {
    const s = await setup('codex');
    const payload = startPayload(randomUUID(), 'app');
    await s.manager.start(payload);
    await argsOf(payload.runId);

    const first = ofRun(payload.runId).slice(0, 3);
    expect(first.map((event) => event.type)).toEqual([
      'session.started',
      'session.output',
      'session.output',
    ]);
    expect(first[2]?.payload).toMatchObject({ data: RUN_NOTICES.first });
  });
});

describe('the connection', () => {
  it('sends session.sync with an exit missed while disconnected', async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-runs-')));
    const repo = join(directory, 'repos', 'app');
    await mkdir(repo, { recursive: true });
    await run('git', ['init', '--quiet', '-b', 'main'], { cwd: repo });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const payload = startPayload(randomUUID(), 'app');
    // Per connection, the messages the Worker sent after it was told it is registered.
    const afterRegistered: WorkerToApiMessage[][] = [];
    let connections = 0;
    server.on('connection', (socket) => {
      const connection = connections++;
      socket.on('message', (data: Buffer) => {
        const message = WorkerToApiMessageSchema.parse(JSON.parse(data.toString('utf8')));
        afterRegistered[connection]?.push(message);
        if (message.type === 'worker.register') {
          // The second registration is answered once the agent has exited.
          setTimeout(
            () => {
              afterRegistered[connection] = [];
              socket.send(
                JSON.stringify({
                  protocolVersion: 1,
                  messageId: randomUUID(),
                  type: 'worker.registered',
                  payload: { workerId: message.payload.workerId, heartbeatIntervalMs: 10_000 },
                }),
              );
              if (connection === 0)
                socket.send(
                  JSON.stringify({
                    protocolVersion: 1,
                    messageId: randomUUID(),
                    type: 'session.start',
                    payload,
                  }),
                );
            },
            connection === 0 ? 0 : 1_500,
          );
        } else if (message.type === 'session.started') socket.terminate();
      });
    });
    const worker = startWorker({
      apiUrl: `ws://127.0.0.1:${address.port}`,
      token: 'test-token',
      id: 'atlas:runs',
      name: 'Runs',
      root: join(directory, 'repos'),
      stateDir: join(directory, 'state'),
      agent: { command: ['/bin/sh', '-c', 'sleep 0.3; exit 3'], sandbox: 'off' },
    });
    try {
      await vi.waitFor(() => expect(afterRegistered[1]?.length).toBeGreaterThan(0), {
        timeout: 15_000,
        interval: 20,
      });
      const first = afterRegistered[0]?.[0];
      expect(first?.type).toBe('session.sync');
      const sync = afterRegistered[1]?.[0];
      expect(sync?.type).toBe('session.sync');
      expect(sync?.payload).toEqual({
        sessions: [],
        exits: [
          {
            sessionId: payload.sessionId,
            runId: payload.runId,
            exitCode: 3,
            message: null,
          },
        ],
      });
    } finally {
      await worker.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
