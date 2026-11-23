import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../apps/api/src/app.js';
import { startWorker } from '../../apps/worker/src/main.js';
import {
  ApiToBoardSessionMessageSchema,
  ProjectCreateResponseSchema,
  TaskResponseSchema,
  VersionListResponseSchema,
  WorkerListResponseSchema,
} from '../../packages/contracts/src/index.js';
import type { ApiToBoardSessionMessage } from '../../packages/contracts/src/index.js';

const agent = fileURLToPath(new URL('../../apps/worker/tests/fixtures/agent.mjs', import.meta.url));

type App = Awaited<ReturnType<typeof buildApp>>;
type Socket = Awaited<ReturnType<App['injectWS']>>;

// Records every frame a Board socket receives, from the moment it opens.
class Board {
  readonly messages: ApiToBoardSessionMessage[] = [];
  constructor(readonly socket: { send(data: string): void }) {}
  get output() {
    return this.messages.flatMap((m) => (m.type === 'output' ? [m.data] : [])).join('');
  }
  get states() {
    return this.messages.flatMap((m) => (m.type === 'session' ? [m.state] : []));
  }
  get session() {
    return this.messages.filter((m) => m.type === 'session').at(-1);
  }
  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }
}

async function openBoard(app: App, taskId: string, sockets: Socket[]) {
  let board!: Board;
  const socket = await app.injectWS(
    `/api/v1/tasks/${taskId}/session`,
    { headers: { host: 'localhost', origin: 'http://localhost:5173' } },
    {
      onInit: (ws) => {
        board = new Board(ws);
        ws.on('message', (data: Buffer) => {
          board.messages.push(
            ApiToBoardSessionMessageSchema.parse(JSON.parse(data.toString('utf8'))),
          );
        });
      },
    },
  );
  sockets.push(socket);
  return board;
}

it('runs an agent session through the Board socket and survives an API restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-sessions-'));
  const options = {
    dbPath: join(directory, 'db.sqlite'),
    workerToken: 'integration-token',
    allowedOrigin: 'http://localhost:5173',
  };
  const sockets: Socket[] = [];
  let app = await buildApp(options);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(new URL(address).port);
  const worker = startWorker({
    apiUrl: address.replace('http:', 'ws:') + '/api/v1/workers/connect',
    token: options.workerToken,
    id: 'atlas:sessions',
    name: 'Sessions worker',
    root: join(directory, 'repos'),
    stateDir: join(directory, 'state'),
    agent: { command: [process.execPath, agent], sandbox: 'off', allowedDomains: [] },
  });
  try {
    const online = async () =>
      WorkerListResponseSchema.parse(
        (await app.inject('/api/v1/workers')).json<unknown>(),
      ).items.filter((item) => item.availability === 'online').length;
    await expect.poll(online, { timeout: 10000 }).toBe(1);

    const created = ProjectCreateResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects',
          payload: {
            name: 'Sessions',
            repository: { mode: 'local', workerId: 'atlas:sessions', relativePath: 'repo' },
          },
        })
      ).json<unknown>(),
    );
    const projectId = created.project.id;
    const versions = async () =>
      VersionListResponseSchema.parse(
        (await app.inject(`/api/v1/projects/${projectId}/versions`)).json<unknown>(),
      ).items;
    // The Worker creates the first version once it has initialized the repository.
    await expect.poll(async () => (await versions()).length, { timeout: 10000 }).toBe(1);
    const versionId = (await versions())[0]?.id;
    const taskResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/versions/${versionId}/tasks`,
      payload: { title: 'Run the agent' },
    });
    const taskId = TaskResponseSchema.parse(taskResponse.json<unknown>()).task.id;

    const board = await openBoard(app, taskId, sockets);
    await expect.poll(() => board.session?.state, { timeout: 10000 }).toBe('none');
    board.send({ type: 'start', cols: 80, rows: 24 });
    await expect.poll(() => board.states, { timeout: 15000 }).toContain('running');
    expect(board.states).toContain('starting');
    expect(board.states.indexOf('starting')).toBeLessThan(board.states.indexOf('running'));
    expect(board.session).toMatchObject({ state: 'running', branch: `atlas/task-${taskId}` });
    await expect.poll(() => board.output, { timeout: 10000 }).toContain('READY');

    board.send({ type: 'input', data: 'ping\n' });
    await expect.poll(() => board.output, { timeout: 10000 }).toContain('ECHO ping');

    const second = await openBoard(app, taskId, sockets);
    await expect.poll(() => second.output, { timeout: 10000 }).toContain('READY');

    for (const socket of sockets.splice(0)) socket.terminate();
    await app.close();
    app = await buildApp(options);
    await app.listen({ host: '127.0.0.1', port });
    await expect.poll(online, { timeout: 10000 }).toBe(1);

    const again = await openBoard(app, taskId, sockets);
    await expect.poll(() => again.session?.state, { timeout: 10000 }).toBeDefined();
    again.send({ type: 'start', cols: 80, rows: 24 });
    await expect.poll(() => again.session?.state, { timeout: 15000 }).toBe('running');
    again.send({ type: 'input', data: 'again\n' });
    await expect.poll(() => again.output, { timeout: 10000 }).toContain('ECHO again');
    expect(again.output).not.toContain('READY');

    again.send({ type: 'stop' });
    await expect.poll(() => again.session?.state, { timeout: 15000 }).toBe('exited');
  } finally {
    for (const socket of sockets) socket.terminate();
    await worker.stop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
