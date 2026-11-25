import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ApiToWorkerMessageSchema } from '@atlas/contracts';
import type WebSocket from 'ws';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BOARD_ORIGIN, TEST_APP_SECRETS, WORKER_TOKEN, buildAuthApp } from './support/auth-app.js';

// The routes this plan opens without a session: its endpoint table plus the Worker socket.
const OPEN_ROUTES: Record<string, string[]> = {
  public: [
    'GET /api/v1/auth/state',
    'GET /api/v1/auth/github/start',
    'GET /api/v1/auth/github/callback',
    'POST /api/v1/auth/sign-out',
  ],
  setup: [
    'POST /api/v1/setup/github/start',
    'GET /api/v1/setup/github/callback',
    'POST /api/v1/setup/owner-code',
  ],
  worker: ['GET /api/v1/workers/connect'],
};
const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

let api: Awaited<ReturnType<typeof buildAuthApp>>;
const sockets: WebSocket[] = [];
beforeEach(async () => {
  api = await buildAuthApp();
  await writeFile(api.appFile, JSON.stringify(TEST_APP_SECRETS), { mode: 0o600 });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await api.close();
});

it('refuses every route without a session unless it is marked open', async () => {
  const routes = api.app.routeList.filter((route) => route.url.startsWith('/api/v1/'));
  expect(routes.length).toBeGreaterThan(10);
  const guarded = routes.filter((route) => !(route.access in OPEN_ROUTES));
  expect(guarded.length).toBeGreaterThan(10);
  for (const route of guarded) {
    const response = await api.app.inject({
      method: route.method as 'GET',
      url: route.url.replace(/:[^/]+/g, 'x'),
      headers: { host: 'localhost' },
      ...(BODY_METHODS.has(route.method) ? { payload: {} } : {}),
    });
    expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    // HEAD responses carry no body.
    if (route.method !== 'HEAD')
      expect(response.json(), `${route.method} ${route.url}`).toMatchObject({
        error: { code: 'sign_in_required' },
      });
  }
});

it('opens only the routes listed in the plan', () => {
  for (const route of api.app.routeList) {
    if (!(route.access in OPEN_ROUTES)) continue;
    // Fastify adds a HEAD route for every GET route, with the same config.
    const method = route.method === 'HEAD' ? 'GET' : route.method;
    expect(OPEN_ROUTES[route.access], `${route.method} ${route.url}`).toContain(
      `${method} ${route.url}`,
    );
  }
});

it('lists only API routes besides the CORS preflight route', () => {
  const others = api.app.routeList.filter((route) => !route.url.startsWith('/api/v1/'));
  expect(others.map((route) => `${route.method} ${route.url}`)).toEqual(['OPTIONS *']);
});

it('refuses the Board session socket at upgrade without a session', async () => {
  await expect(
    api.app.injectWS('/api/v1/tasks/x/session', {
      headers: { host: 'localhost', origin: BOARD_ORIGIN },
    }),
  ).rejects.toThrow('401');
});

it('registers a Worker on its socket without a session', async () => {
  const socket = await api.app.injectWS('/api/v1/workers/connect', {
    headers: { host: 'localhost', authorization: `Bearer ${WORKER_TOKEN}` },
  });
  sockets.push(socket);
  const reply = new Promise<unknown>((resolve) => {
    socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8'))));
  });
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
  expect(ApiToWorkerMessageSchema.parse(await reply).type).toBe('worker.registered');
});
