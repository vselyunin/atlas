import type { ApiToWorkerMessage, Worker, WorkerRegister } from '@atlas/contracts';
import { HEARTBEAT_STALE_MS, HUMAN_WORKER_ID } from '@atlas/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { posix } from 'node:path';
import WebSocket from 'ws';
import type { ApiContext } from '../db/client.js';
import { operations, workers } from '../db/schema.js';
import { ApiError } from '../http/errors.js';

interface Connection {
  socket: WebSocket;
  timer: NodeJS.Timeout;
}

export class WorkerRegistry {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly context: ApiContext) {}

  register(
    socket: WebSocket,
    { workerId, name, workspaceRoot, capabilities }: WorkerRegister['payload'],
  ) {
    if (
      workerId === HUMAN_WORKER_ID ||
      workerId.startsWith('human:') ||
      /\s/u.test(workerId) ||
      Array.from(workerId).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
      throw new ApiError(403, 'invalid_worker_id', 'Invalid Atlas Worker identity');
    }
    if (this.connections.has(workerId)) {
      throw new ApiError(409, 'duplicate_worker', 'That Worker is already connected');
    }
    if (!posix.isAbsolute(workspaceRoot) || workspaceRoot.includes('\0')) {
      throw new ApiError(
        400,
        'invalid_workspace',
        'Worker workspace must be an absolute POSIX path',
      );
    }
    const worker: Worker = {
      id: workerId,
      name,
      kind: 'atlas',
      availability: 'online',
      workspaceRoot: posix.resolve(workspaceRoot),
      lastSeenAt: this.context.now(),
      capabilities,
    };
    this.context.db
      .insert(workers)
      .values(worker)
      .onConflictDoUpdate({ target: workers.id, set: worker })
      .run();
    this.connections.set(workerId, { socket, timer: this.startTimer(socket) });
  }

  heartbeat(workerId: string) {
    const connection = this.connections.get(workerId);
    if (!connection) return;
    this.context.db
      .update(workers)
      .set({ lastSeenAt: this.context.now() })
      .where(eq(workers.id, workerId))
      .run();
    connection.timer.refresh();
  }

  isOnline(workerId: string): boolean {
    return this.connections.get(workerId)?.socket.readyState === WebSocket.OPEN;
  }

  send(workerId: string, message: ApiToWorkerMessage): boolean {
    const socket = this.connections.get(workerId)?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message), (error) => {
      if (error) socket.terminate();
    });
    return true;
  }

  disconnect(workerId: string, socket: WebSocket) {
    const connection = this.connections.get(workerId);
    if (connection?.socket !== socket) return;
    this.connections.delete(workerId);
    clearTimeout(connection.timer);
    this.context.db.transaction(
      (tx) => {
        tx.update(workers).set({ availability: 'offline' }).where(eq(workers.id, workerId)).run();
        tx.update(operations)
          .set({ connectionLost: true, updatedAt: this.context.now() })
          .where(
            and(
              eq(operations.workerId, workerId),
              inArray(operations.state, ['pending', 'accepted']),
              eq(operations.connectionLost, false),
            ),
          )
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  private startTimer(socket: WebSocket) {
    const timer = setTimeout(() => socket.terminate(), HEARTBEAT_STALE_MS);
    timer.unref();
    return timer;
  }
}
