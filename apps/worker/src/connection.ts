import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import {
  ApiToWorkerMessageSchema,
  MAX_WS_FRAME_BYTES,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from '@atlas/contracts';
import type { WorkerToApiMessage, RepositoryInitCommand } from '@atlas/contracts';
import type { WorkerConfig } from './config.js';
import type { Journal } from './state/journal.js';
import { initializeRepository } from './repositories/initialize.js';
import { SessionManager } from './sessions/manager.js';

function text(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8');
}

export function connect(config: WorkerConfig, journal: Journal): { stop(): Promise<void> } {
  let socket: WebSocket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let stopped = false;
  let registered = false;
  let attempts = 0;
  let queue = Promise.resolve();
  const active = new Map<string, RepositoryInitCommand>();
  const send = (message: WorkerToApiMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const envelope = () => ({ protocolVersion: 1 as const, messageId: randomUUID() });
  // Spike: output produced while disconnected is dropped.
  const sessions = new SessionManager(config.root, (event) => send({ ...envelope(), ...event }));
  const replay = () => {
    for (const entry of journal.entries()) {
      if (entry.outcome && !entry.acknowledged)
        send({
          ...envelope(),
          type: 'command.result',
          commandId: entry.command.commandId,
          payload: entry.outcome,
        });
    }
  };
  const dispatch = (command: RepositoryInitCommand) => {
    if (stopped) return;
    const pending = active.get(command.commandId);
    if (pending) {
      if (!isDeepStrictEqual(pending.payload, command.payload)) {
        send({
          ...envelope(),
          type: 'protocol.error',
          commandId: command.commandId,
          payload: {
            code: 'command_conflict',
            message: 'An active command id cannot have a different payload',
          },
        });
      }
      return;
    }
    active.set(command.commandId, command);
    queue = queue.then(async () => {
      try {
        const outcomePromise = initializeRepository(command, {
          root: config.root,
          journal,
          onAccepted: () => {
            if (registered)
              send({
                ...envelope(),
                type: 'command.accepted',
                commandId: command.commandId,
                payload: {},
              });
          },
        });
        // initializeRepository persists intent before the first filesystem mutation.
        const outcome = await outcomePromise;
        if (registered)
          send({
            ...envelope(),
            type: 'command.result',
            commandId: command.commandId,
            payload: outcome,
          });
      } catch (error) {
        if (registered)
          send({
            ...envelope(),
            type: 'protocol.error',
            commandId: command.commandId,
            payload: {
              code: 'command_error',
              message: error instanceof Error ? error.message : 'Command failed',
            },
          });
      } finally {
        active.delete(command.commandId);
      }
    });
  };
  const open = () => {
    if (stopped) return;
    const current = new WebSocket(config.apiUrl, {
      headers: { Authorization: `Bearer ${config.token}` },
      maxPayload: MAX_WS_FRAME_BYTES,
      handshakeTimeout: 5_000,
    });
    socket = current;
    current.on('open', () => {
      send({
        ...envelope(),
        type: 'worker.register',
        payload: {
          workerId: config.id,
          name: config.name,
          workspaceRoot: config.root,
          capabilities: ['repository.init'],
        },
      });
    });
    current.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('Only JSON text is supported');
        const message = ApiToWorkerMessageSchema.parse(JSON.parse(text(data)));
        if (message.type === 'worker.registered') {
          if (message.payload.workerId !== config.id) throw new Error('Worker identity mismatch');
          registered = true;
          attempts = 0;
          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            send({ ...envelope(), type: 'worker.heartbeat', payload: { workerId: config.id } });
            replay();
          }, message.payload.heartbeatIntervalMs);
          replay();
          console.log(`Worker ${config.name} connected`);
        } else if (message.type === 'command.dispatch') {
          if (!registered) throw new Error('Registration required');
          dispatch(message);
        } else if (message.type === 'command.result_ack') {
          if (registered) journal.acknowledge(message.commandId);
        } else if (message.type === 'session.start') {
          if (!registered) throw new Error('Registration required');
          void sessions.start(message.payload);
        } else if (message.type === 'session.input') {
          sessions.input(message.payload.sessionId, message.payload.data);
        } else if (message.type === 'session.resize') {
          sessions.resize(message.payload.sessionId, message.payload);
        } else if (message.type === 'session.stop') {
          sessions.stop(message.payload.sessionId);
        } else if (message.type === 'protocol.error') {
          console.error(`API: ${message.payload.message}`);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Invalid API message');
        current.close(1008);
      }
    });
    current.on('error', () => {
      /* close schedules reconnect; credentials are never logged */
    });
    current.on('close', () => {
      registered = false;
      clearInterval(heartbeat);
      if (!stopped) {
        const delay = Math.min(
          RECONNECT_MAX_DELAY_MS,
          RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(attempts++, 10),
        );
        timer = setTimeout(open, delay * (0.8 + Math.random() * 0.2));
      }
    });
  };
  open();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      await queue;
      sessions.stopAll();
      registered = false;
      socket?.terminate();
    },
  };
}
