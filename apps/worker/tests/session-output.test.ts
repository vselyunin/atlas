import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_SESSION_OUTPUT_CHARS } from '@atlas/contracts';
import { prepareConfig } from '../src/config.js';
import { SessionManager } from '../src/sessions/manager.js';
import type { SessionEvent } from '../src/sessions/manager.js';
import { SANDBOX_OFF_NOTICE } from '../src/sessions/sandbox.js';
import { startPayload } from './support/sessions.js';

// A real pty hands over small reads, so a single oversized read needs a fake terminal.
const terminal = vi.hoisted(() => ({
  emitData: undefined as ((data: string) => void) | undefined,
}));
vi.mock('node-pty', () => ({
  default: {
    spawn: () => ({
      onData: (listener: (data: string) => void) => {
        terminal.emitData = listener;
      },
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
    }),
  },
}));

const run = promisify(execFile);
let directory: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-output-')));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('splits one oversized terminal read into chunks within the limit', async () => {
  const config = prepareConfig({
    apiUrl: 'ws://127.0.0.1:1/api/v1/workers/connect',
    token: 'test-token',
    id: 'atlas:test',
    name: 'Test worker',
    root: join(directory, 'repos'),
    stateDir: join(directory, 'state'),
    agent: { command: ['fake-agent'], sandbox: 'off' },
  });
  const repository = join(config.root, 'app');
  await mkdir(repository, { recursive: true });
  await run('git', ['init', '--quiet', '-b', 'main'], { cwd: repository });
  const events: SessionEvent[] = [];
  const manager = new SessionManager(config, (event) => events.push(event));
  const payload = startPayload(randomUUID(), 'app');
  await manager.start(payload);

  const data = 'y'.repeat(MAX_SESSION_OUTPUT_CHARS * 2 + 5);
  terminal.emitData?.(data);

  const [notice, ...chunks] = events.flatMap((event) =>
    event.type === 'session.output' ? [event.payload] : [],
  );
  expect(notice?.data).toBe(SANDBOX_OFF_NOTICE);
  expect(chunks.map((chunk) => chunk.data.length)).toEqual([
    MAX_SESSION_OUTPUT_CHARS,
    MAX_SESSION_OUTPUT_CHARS,
    5,
  ]);
  expect(chunks.map((chunk) => chunk.data).join('')).toBe(data);
  expect(chunks.every((chunk) => chunk.runId === payload.runId)).toBe(true);
  // Removes the manager's Git excludes file.
  manager.stopAll();
});
