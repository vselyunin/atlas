import { randomUUID } from 'node:crypto';
import {
  ApiToBoardSessionMessageSchema,
  ApiToWorkerMessageSchema,
  ProjectCreateResponseSchema,
  TaskResponseSchema,
  VersionListResponseSchema,
} from '@atlas/contracts';
import type { ApiToBoardSessionMessage, ApiToWorkerMessage } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { buildApp } from '../../src/app.js';

export const BOARD_ORIGIN = 'http://localhost:5173';
const TIMEOUT_MS = 3000;

// Resolves once the predicate holds; rejects after the timeout instead of hanging.
export async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Collects every frame from the moment it is created, so none is missed.
class Inbox<T extends { type: string }> {
  readonly messages: T[] = [];
  private readonly consumed = new Set<T>();

  constructor(socket: WebSocket, parse: (raw: unknown) => T) {
    socket.on('message', (data: Buffer) => {
      this.messages.push(parse(JSON.parse(data.toString('utf8'))));
    });
  }

  next<K extends T['type']>(type: K): Promise<Extract<T, { type: K }>> {
    return until(() => {
      const found = this.messages.find((m) => m.type === type && !this.consumed.has(m));
      if (found) this.consumed.add(found);
      return found as Extract<T, { type: K }> | undefined;
    }, `a ${type} message`);
  }
}

export class WorkerSocket {
  private readonly inbox: Inbox<ApiToWorkerMessage>;
  constructor(
    readonly socket: WebSocket,
    readonly id: string,
  ) {
    this.inbox = new Inbox(socket, (raw) => ApiToWorkerMessageSchema.parse(raw));
  }
  get messages() {
    return this.inbox.messages;
  }
  received<K extends ApiToWorkerMessage['type']>(type: K) {
    return this.inbox.next(type);
  }
  send(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
    this.socket.send(
      JSON.stringify({ protocolVersion: 1, messageId: randomUUID(), type, payload, ...extra }),
    );
  }
}

export class BoardSocket {
  private readonly inbox: Inbox<ApiToBoardSessionMessage>;
  constructor(readonly socket: WebSocket) {
    this.inbox = new Inbox(socket, (raw) => ApiToBoardSessionMessageSchema.parse(raw));
  }
  get messages() {
    return this.inbox.messages;
  }
  next<K extends ApiToBoardSessionMessage['type']>(type: K) {
    return this.inbox.next(type);
  }
  send(message: unknown) {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }
}

export async function createApi() {
  const app: FastifyInstance = await buildApp({
    dbPath: ':memory:',
    workerToken: 'test-token',
    allowedOrigin: BOARD_ORIGIN,
  });
  const sockets: WebSocket[] = [];
  const workers = new Map<string, WorkerSocket>();

  async function registerWorker(id: string, capabilities: string[]) {
    // onInit runs before the upgrade, so the inbox sees the very first frame.
    let worker!: WorkerSocket;
    const socket = await app.injectWS(
      '/api/v1/workers/connect',
      { headers: { host: 'localhost', authorization: 'Bearer test-token' } },
      { onInit: (ws: WebSocket) => (worker = new WorkerSocket(ws, id)) },
    );
    sockets.push(socket);
    worker.send('worker.register', {
      workerId: id,
      name: 'Test',
      workspaceRoot: '/tmp/atlas-test',
      capabilities,
    });
    await worker.received('worker.registered');
    workers.set(id, worker);
    return worker;
  }

  // Pass `null` to connect without an Origin header; omit it for the Board origin.
  async function board(taskId: string, origin: string | null = BOARD_ORIGIN) {
    let board!: BoardSocket;
    const socket = await app.injectWS(
      `/api/v1/tasks/${taskId}/session`,
      { headers: { host: 'localhost', ...(origin ? { origin } : {}) } },
      { onInit: (ws: WebSocket) => (board = new BoardSocket(ws)) },
    );
    sockets.push(socket);
    return board;
  }

  async function createTask(projectId: string) {
    const { items } = VersionListResponseSchema.parse(
      (await app.inject(`/api/v1/projects/${projectId}/versions`)).json<unknown>(),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/versions/${items[0]?.id}/tasks`,
      payload: { title: 'Fix the login bug', description: 'It fails on Safari.' },
    });
    return TaskResponseSchema.parse(response.json<unknown>()).task.id;
  }

  // Creates a local project, completes its repository.init from the fake Worker, adds a task.
  async function localTask(workerId: string) {
    const worker = workers.get(workerId);
    if (!worker) throw new Error(`Register ${workerId} first`);
    const created = ProjectCreateResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects',
          payload: {
            name: 'Repo',
            repository: { mode: 'local', workerId, relativePath: 'repo' },
          },
        })
      ).json<unknown>(),
    );
    const command = await worker.received('command.dispatch');
    worker.send(
      'command.result',
      { status: 'succeeded', localPath: '/tmp/atlas-test/repo' },
      { commandId: command.commandId },
    );
    await worker.received('command.result_ack');
    return { taskId: await createTask(created.project.id), projectId: created.project.id };
  }

  async function existingRepoTask() {
    const created = ProjectCreateResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects',
          payload: {
            name: 'Remote',
            repository: { mode: 'existing', gitUrl: 'https://example.com/acme/repo.git' },
          },
        })
      ).json<unknown>(),
    );
    return { taskId: await createTask(created.project.id) };
  }

  return {
    app,
    registerWorker,
    board,
    localTask,
    existingRepoTask,
    async close() {
      for (const socket of sockets) socket.terminate();
      await app.close();
    },
  };
}
