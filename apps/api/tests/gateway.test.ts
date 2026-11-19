import { beforeEach, afterEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import {
  ApiToWorkerMessageSchema,
  OperationResponseSchema,
  ProjectCreateResponseSchema,
  VersionListResponseSchema,
} from '@atlas/contracts';
import type { ApiToWorkerMessage } from '@atlas/contracts';
import { buildApp } from '../src/app.js';
let app: FastifyInstance;
const sockets: WebSocket[] = [];
beforeEach(async () => {
  app = await buildApp({
    dbPath: ':memory:',
    workerToken: 'test-token',
    allowedOrigin: 'http://localhost:5173',
  });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app.close();
});
const base = () => ({ protocolVersion: 1, messageId: randomUUID() });
function next(socket: WebSocket): Promise<ApiToWorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No protocol response')), 3000);
    socket.once('message', (data: Buffer) => {
      clearTimeout(timer);
      try {
        resolve(ApiToWorkerMessageSchema.parse(JSON.parse(data.toString('utf8'))));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Invalid response'));
      }
    });
  });
}
async function connect() {
  const socket = await app.injectWS('/api/v1/workers/connect', {
    headers: { host: 'localhost', authorization: 'Bearer test-token' },
  });
  sockets.push(socket);
  return socket;
}
async function register(socket: WebSocket, id = 'atlas:test') {
  const response = next(socket);
  socket.send(
    JSON.stringify({
      ...base(),
      type: 'worker.register',
      payload: {
        workerId: id,
        name: 'Test',
        workspaceRoot: '/tmp/atlas-test',
        capabilities: ['repository.init'],
      },
    }),
  );
  return response;
}
it('rejects unauthenticated and browser-origin worker upgrades', async () => {
  await expect(
    app.injectWS('/api/v1/workers/connect', { headers: { host: 'localhost' } }),
  ).rejects.toThrow('403');
  await expect(
    app.injectWS('/api/v1/workers/connect', {
      headers: {
        host: 'localhost',
        authorization: 'Bearer test-token',
        origin: 'http://localhost:5173',
      },
    }),
  ).rejects.toThrow('403');
});
it('rejects duplicate identities and unsupported protocol versions', async () => {
  const first = await connect();
  expect((await register(first)).type).toBe('worker.registered');
  const duplicate = await connect();
  expect(await register(duplicate)).toMatchObject({
    type: 'protocol.error',
    payload: { code: 'duplicate_worker' },
  });
  const invalid = await connect();
  const response = next(invalid);
  invalid.send(
    JSON.stringify({
      protocolVersion: 2,
      messageId: 'bad',
      type: 'worker.heartbeat',
      payload: { workerId: 'x' },
    }),
  );
  expect(await response).toMatchObject({
    type: 'protocol.error',
    payload: { code: 'unsupported_protocol_version' },
  });
});
it('deduplicates results, rejects another worker and preserves the first terminal outcome', async () => {
  const socket = await connect();
  await register(socket);
  const stranger = await connect();
  await register(stranger, 'atlas:stranger');
  const commandPromise = next(socket);
  const created = ProjectCreateResponseSchema.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: {
          name: 'Repo',
          repository: { mode: 'local', workerId: 'atlas:test', relativePath: 'repo' },
        },
      })
    ).json<unknown>(),
  );
  const command = await commandPromise;
  if (command.type !== 'command.dispatch') throw new Error('Expected command dispatch');
  const message = {
    ...base(),
    type: 'command.result',
    commandId: command.commandId,
    payload: { status: 'succeeded', localPath: '/tmp/atlas-test/repo' },
  };
  const rejection = next(stranger);
  stranger.send(JSON.stringify(message));
  expect(await rejection).toMatchObject({
    type: 'protocol.error',
    payload: { code: 'wrong_worker' },
  });
  for (let index = 0; index < 2; index++) {
    const ack = next(socket);
    socket.send(JSON.stringify(message));
    expect((await ack).type).toBe('command.result_ack');
  }
  const conflict = next(socket);
  socket.send(
    JSON.stringify({
      ...message,
      payload: { status: 'failed', error: { code: 'oops', message: 'Different outcome' } },
    }),
  );
  expect(await conflict).toMatchObject({
    type: 'protocol.error',
    payload: { code: 'result_conflict' },
  });
  expect(
    OperationResponseSchema.parse(
      (await app.inject(`/api/v1/operations/${command.commandId}`)).json<unknown>(),
    ).operation.state,
  ).toBe('succeeded');
  expect(
    VersionListResponseSchema.parse(
      (await app.inject(`/api/v1/projects/${created.project.id}/versions`)).json<unknown>(),
    ).items,
  ).toHaveLength(1);
});
