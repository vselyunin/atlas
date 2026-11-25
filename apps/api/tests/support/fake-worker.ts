import { randomUUID } from 'node:crypto';
import { ApiToWorkerMessageSchema } from '@atlas/contracts';
import type { ApiToWorkerMessage } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { WORKER_TOKEN } from './auth-app.js';

// A Worker driven by hand over the real Worker socket. Every message from the API is kept until
// a test takes it with `next`, so no message is lost between steps.

export const ALL_CAPABILITIES = ['repository.init', 'agent.session', 'repository.clone'] as const;
export const NO_CLONE_CAPABILITIES = ['repository.init', 'agent.session'] as const;

export type FakeWorkerOptions = {
  workerId?: string;
  workspaceRoot?: string;
  capabilities?: readonly string[];
};

export type FakeWorker = {
  workerId: string;
  socket: WebSocket;
  // Waits for the next message of this type (any type when omitted) and takes it.
  next<T extends ApiToWorkerMessage['type']>(
    type?: T,
    timeoutMs?: number,
  ): Promise<Extract<ApiToWorkerMessage, { type: T }>>;
  // Messages received and not yet taken.
  pending(): ApiToWorkerMessage[];
  send(message: { type: string; payload: unknown; commandId?: string }): void;
  // Sends a credential request and waits for the grant or refusal for that command.
  requestCredential(
    commandId: string,
  ): Promise<Extract<ApiToWorkerMessage, { type: 'credential.grant' | 'credential.refusal' }>>;
  close(): Promise<void>;
};

export async function connectWorker(
  app: FastifyInstance,
  options: FakeWorkerOptions = {},
): Promise<FakeWorker> {
  const workerId = options.workerId ?? 'atlas:test';
  const socket = await app.injectWS('/api/v1/workers/connect', {
    headers: { host: 'localhost', authorization: `Bearer ${WORKER_TOKEN}` },
  });
  const inbox: ApiToWorkerMessage[] = [];
  const waiters: Array<{ match: (message: ApiToWorkerMessage) => boolean; take(): void }> = [];
  socket.on('message', (data: Buffer) => {
    const message = ApiToWorkerMessageSchema.parse(JSON.parse(data.toString('utf8')));
    inbox.push(message);
    for (const waiter of [...waiters]) waiter.take();
  });

  function take(match: (message: ApiToWorkerMessage) => boolean, timeoutMs: number) {
    return new Promise<ApiToWorkerMessage>((resolve, reject) => {
      const waiter = {
        match,
        take() {
          const index = inbox.findIndex(match);
          if (index === -1) return;
          const [message] = inbox.splice(index, 1);
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(waiter), 1);
          if (message) resolve(message);
        },
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error('No matching message from the API'));
      }, timeoutMs);
      waiters.push(waiter);
      waiter.take();
    });
  }

  const send: FakeWorker['send'] = (message) => {
    socket.send(JSON.stringify({ protocolVersion: 1, messageId: randomUUID(), ...message }));
  };

  const worker: FakeWorker = {
    workerId,
    socket,
    next: (type, timeoutMs = 5000) =>
      take((message) => type === undefined || message.type === type, timeoutMs) as never,
    pending: () => [...inbox],
    send,
    requestCredential(commandId) {
      const reply = take(
        (message) =>
          (message.type === 'credential.grant' || message.type === 'credential.refusal') &&
          message.commandId === commandId,
        25_000,
      );
      send({ type: 'credential.request', commandId, payload: {} });
      return reply as never;
    },
    close() {
      return new Promise<void>((resolve) => {
        if (socket.readyState === socket.CLOSED) return resolve();
        socket.once('close', () => resolve());
        socket.terminate();
      });
    },
  };

  send({
    type: 'worker.register',
    payload: {
      workerId,
      name: 'Test Worker',
      workspaceRoot: options.workspaceRoot ?? '/tmp/atlas-test',
      capabilities: options.capabilities ?? ALL_CAPABILITIES,
    },
  });
  await worker.next('worker.registered');
  return worker;
}
