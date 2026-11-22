import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SessionStartPayload } from '@atlas/contracts';
import { prepareConfig } from '../../src/config.js';
import { SessionManager } from '../../src/sessions/manager.js';
import type { SessionEvent } from '../../src/sessions/manager.js';

const run = promisify(execFile);
const agentPath = fileURLToPath(new URL('../fixtures/agent.mjs', import.meta.url));
const TIMEOUT_MS = 10_000;

export interface Harness {
  root: string;
  stateDir: string;
  manager: SessionManager;
  events: SessionEvent[];
  waitFor(type: SessionEvent['type'], sessionId: string): Promise<SessionEvent>;
  waitForOutput(sessionId: string, text: string): Promise<void>;
  output(sessionId: string): string;
  initRepository(relativePath: string): Promise<string>;
  cleanup(): Promise<void>;
}

export function startPayload(
  sessionId: string,
  relativePath: string,
  overrides: Partial<SessionStartPayload> = {},
): SessionStartPayload {
  return {
    sessionId,
    runId: randomUUID(),
    projectId: 'project-1',
    relativePath,
    prompt: '',
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

export interface HarnessOptions {
  agentArgs?: string[];
  stopGraceMs?: number;
  sandbox?: 'required' | 'off';
  // Put first on PATH for the Worker and the processes it starts, for example to supply a fake srt.
  pathPrefix?: string;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  // A temporary directory on the Linux filesystem keeps Git and the pty behavior realistic.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-sessions-')));
  const originalPath = process.env.PATH;
  if (options.pathPrefix !== undefined) {
    process.env.PATH = `${options.pathPrefix}:${originalPath ?? ''}`;
  }
  const config = prepareConfig({
    apiUrl: 'ws://127.0.0.1:1/api/v1/workers/connect',
    token: 'test-token',
    id: 'atlas:test',
    name: 'Test worker',
    root: join(directory, 'repos'),
    stateDir: join(directory, 'state'),
    agent: {
      command: [process.execPath, agentPath, ...(options.agentArgs ?? [])],
      sandbox: options.sandbox ?? 'off',
    },
  });

  const events: SessionEvent[] = [];
  const listeners = new Set<() => void>();
  const manager = new SessionManager(
    config,
    (event) => {
      events.push(event);
      for (const listener of [...listeners]) listener();
    },
    options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs },
  );

  const until = <T>(describe: string, probe: () => T | undefined): Promise<T> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const value = probe();
        if (value === undefined) return;
        cleanUp();
        resolve(value);
      };
      const timer = setTimeout(() => {
        cleanUp();
        reject(new Error(`Timed out waiting for ${describe}`));
      }, TIMEOUT_MS);
      const cleanUp = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });

  const output = (sessionId: string) =>
    events
      .flatMap((event) =>
        event.type === 'session.output' && event.payload.sessionId === sessionId
          ? [event.payload.data]
          : [],
      )
      .join('');

  return {
    root: config.root,
    stateDir: config.stateDir,
    manager,
    events,
    waitFor: (type, sessionId) =>
      until(`${type} for ${sessionId}`, () =>
        events.find((event) => event.type === type && event.payload.sessionId === sessionId),
      ),
    waitForOutput: async (sessionId, text) => {
      await until(`output ${JSON.stringify(text)} for ${sessionId}`, () =>
        output(sessionId).includes(text) ? true : undefined,
      );
    },
    output,
    async initRepository(relativePath) {
      const path = join(config.root, relativePath);
      await mkdir(path, { recursive: true });
      await run('git', ['init', '--quiet', '-b', 'main'], { cwd: path });
      return path;
    },
    async cleanup() {
      manager.stopAll();
      const started = new Set<string>();
      const exited = new Set<string>();
      for (const event of events) {
        if (event.type === 'session.started') started.add(event.payload.sessionId);
        if (event.type === 'session.exit') exited.add(event.payload.sessionId);
      }
      try {
        for (const sessionId of started) {
          if (!exited.has(sessionId))
            await until(`exit of ${sessionId}`, () => {
              return events.find(
                (event) => event.type === 'session.exit' && event.payload.sessionId === sessionId,
              );
            });
        }
      } finally {
        if (options.pathPrefix !== undefined) process.env.PATH = originalPath;
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
