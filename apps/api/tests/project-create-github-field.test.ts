import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { ProjectListResponseSchema } from '@atlas/contracts';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let socket: WebSocket | undefined;
beforeEach(async () => {
  app = await buildApp({
    dbPath: ':memory:',
    workerToken: 'test-token',
    allowedOrigin: 'http://localhost:5173',
  });
});
afterEach(async () => {
  socket?.terminate();
  socket = undefined;
  await app.close();
});

it('refuses githubRepositoryId while sign-in is off and stores no project', async () => {
  socket = await app.injectWS('/api/v1/workers/connect', {
    headers: { host: 'localhost', authorization: 'Bearer test-token' },
  });
  const registered = new Promise<void>((resolve) => socket?.once('message', () => resolve()));
  socket.send(
    JSON.stringify({
      protocolVersion: 1,
      messageId: randomUUID(),
      type: 'worker.register',
      payload: {
        workerId: 'atlas:test',
        name: 'Test',
        workspaceRoot: '/tmp/atlas-test',
        capabilities: ['repository.init'],
      },
    }),
  );
  await registered;

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: {
      name: 'Repo',
      repository: {
        mode: 'local',
        workerId: 'atlas:test',
        relativePath: 'repo',
        githubRepositoryId: 42,
      },
    },
  });
  // buildApp without sign-in options runs with sign-in off, so there is no GitHub App to clone with.
  expect(res.statusCode).toBe(409);
  expect(res.json<{ error: { code: string } }>().error.code).toBe('github_unavailable');

  const list = await app.inject('/api/v1/projects');
  expect(list.statusCode).toBe(200);
  const { items } = ProjectListResponseSchema.parse(list.json<unknown>());
  expect(items).toHaveLength(0);
});
