import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { WorkerToApiMessageSchema, makeRepositoryCloneCommandFixture } from '@atlas/contracts';
import type { WorkerToApiMessage } from '@atlas/contracts';
import { startWorker } from '../src/main.js';
import { CredentialExchange, CredentialUnavailable } from '../src/repositories/credential.js';
import { Journal } from '../src/state/journal.js';
import { startGitServer } from './support/git-server.js';
import type { GitServer } from './support/git-server.js';

const TOKEN = `ghs_${randomUUID().replaceAll('-', '')}`;

let directory: string;
let api: WebSocketServer;
let git: GitServer;
let messages: WorkerToApiMessage[];
let onMessage: (socket: WebSocket, message: WorkerToApiMessage) => void;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-clone-connection-')));
  git = await startGitServer({ token: TOKEN });
  await git.addRepository('team/project', { 'README.md': 'hello' });
  messages = [];
  onMessage = () => {};
  api = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(api, 'listening');
  api.on('connection', (socket) => {
    socket.on('message', (data: Buffer) => {
      const message = WorkerToApiMessageSchema.parse(JSON.parse(data.toString('utf8')));
      messages.push(message);
      if (message.type === 'worker.register') {
        socket.send(
          JSON.stringify({
            protocolVersion: 1,
            messageId: randomUUID(),
            type: 'worker.registered',
            payload: { workerId: message.payload.workerId, heartbeatIntervalMs: 10000 },
          }),
        );
      }
      onMessage(socket, message);
    });
  });
});

afterEach(async () => {
  for (const socket of api.clients) socket.terminate();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await git.close();
  await rm(directory, { recursive: true, force: true });
});

function worker() {
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  return startWorker({
    apiUrl: `ws://127.0.0.1:${address.port}`,
    token: 'worker-token',
    id: 'atlas:clone',
    name: 'Clone',
    root: join(directory, 'repos'),
    stateDir: join(directory, 'state'),
    gitHostUrl: git.url,
  });
}

const reply = (socket: WebSocket, message: object) =>
  socket.send(JSON.stringify({ protocolVersion: 1, messageId: randomUUID(), ...message }));

const results = () => messages.filter((message) => message.type === 'command.result');

it('registers the clone capability and clones with a granted credential', async () => {
  const command = makeRepositoryCloneCommandFixture({ commandId: randomUUID() });
  onMessage = (socket, message) => {
    if (message.type === 'worker.register') socket.send(JSON.stringify(command));
    if (message.type === 'credential.request' && message.commandId === command.commandId)
      reply(socket, {
        type: 'credential.grant',
        commandId: command.commandId,
        payload: {
          token: TOKEN,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          repository: 'team/project',
        },
      });
  };
  const running = worker();
  try {
    await expect.poll(() => results().length, { timeout: 10_000 }).toBe(1);
    const register = messages.find((message) => message.type === 'worker.register');
    expect(register?.payload).toMatchObject({
      capabilities: ['repository.init', 'agent.session', 'repository.clone'],
    });
    expect(messages.map((message) => message.type)).toContain('command.accepted');
    expect(results()[0]?.payload).toEqual({
      status: 'succeeded',
      localPath: join(directory, 'repos', 'project'),
    });
    expect(await readFile(join(directory, 'repos', 'project', 'README.md'), 'utf8')).toBe('hello');
  } finally {
    await running.stop();
  }
});

it('fails the clone with the refusal message', async () => {
  const command = makeRepositoryCloneCommandFixture({ commandId: randomUUID() });
  onMessage = (socket, message) => {
    if (message.type === 'worker.register') socket.send(JSON.stringify(command));
    if (message.type === 'credential.request')
      reply(socket, {
        type: 'credential.refusal',
        commandId: message.commandId,
        payload: { code: 'not_linked', message: 'The project has no linked repository' },
      });
  };
  const running = worker();
  try {
    await expect.poll(() => results().length, { timeout: 10_000 }).toBe(1);
    expect(results()[0]?.payload).toEqual({
      status: 'failed',
      error: { code: 'not_linked', message: 'The project has no linked repository' },
    });
  } finally {
    await running.stop();
  }
});

it('needs attention when the connection drops while waiting for a credential', async () => {
  const command = makeRepositoryCloneCommandFixture({ commandId: randomUUID() });
  let registrations = 0;
  onMessage = (socket, message) => {
    if (message.type === 'worker.register' && ++registrations === 1)
      socket.send(JSON.stringify(command));
    if (message.type === 'credential.request') socket.terminate();
  };
  const running = worker();
  try {
    await expect.poll(() => results().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(results()[0]?.payload.status).toBe('needs_attention');
    expect(git.requests).toEqual([]);
  } finally {
    await running.stop();
  }
});

it('stops promptly while a clone waits, reporting needs attention', async () => {
  const command = makeRepositoryCloneCommandFixture({ commandId: randomUUID() });
  let asked: () => void = () => {};
  const requested = new Promise<void>((resolve) => (asked = resolve));
  onMessage = (socket, message) => {
    if (message.type === 'worker.register') socket.send(JSON.stringify(command));
    if (message.type === 'credential.request') asked();
  };
  const running = worker();
  await requested;
  const started = Date.now();
  await running.stop();
  expect(Date.now() - started).toBeLessThan(2_000);
  // The result is journaled and replayed on the next connection.
  expect(new Journal(join(directory, 'state')).get(command.commandId)).toMatchObject({
    stage: 'finished',
    outcome: { status: 'needs_attention' },
  });
});

it('does not start a clone still queued when the Worker stops', async () => {
  const first = makeRepositoryCloneCommandFixture({ commandId: randomUUID() });
  const second = makeRepositoryCloneCommandFixture({
    commandId: randomUUID(),
    payload: { ...first.payload, relativePath: 'second' },
  });
  let asked: () => void = () => {};
  const requested = new Promise<void>((resolve) => (asked = resolve));
  onMessage = (socket, message) => {
    if (message.type === 'worker.register') {
      socket.send(JSON.stringify(first));
      socket.send(JSON.stringify(second));
    }
    if (message.type === 'credential.request') asked();
  };
  const running = worker();
  await requested;
  await running.stop();
  const journal = new Journal(join(directory, 'state'));
  expect(journal.get(first.commandId)?.outcome?.status).toBe('needs_attention');
  expect(journal.get(second.commandId)).toBeNull();
  await expect(readFile(join(directory, 'repos', 'second'))).rejects.toThrow('ENOENT');
  expect(
    messages.some(
      (message) => message.type === 'command.accepted' && message.commandId === second.commandId,
    ),
  ).toBe(false);
});

it('rejects a pending request after the reply timeout and on drop', async () => {
  const sent: string[] = [];
  const exchange = new CredentialExchange((id) => {
    sent.push(id);
    return true;
  }, 50);
  const signal = new AbortController().signal;
  await expect(exchange.request('a', signal)).rejects.toBeInstanceOf(CredentialUnavailable);
  const pending = exchange.request('b', signal);
  exchange.dropAll();
  await expect(pending).rejects.toBeInstanceOf(CredentialUnavailable);
  expect(sent).toEqual(['a', 'b']);
  expect(exchange.grant('b', { token: 'x', expiresAt: '', repository: 'team/project' })).toBe(
    false,
  );
  const offline = new CredentialExchange(() => false, 10_000);
  await expect(offline.request('c', signal)).rejects.toBeInstanceOf(CredentialUnavailable);
});
