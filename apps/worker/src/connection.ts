import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import {
  AGENT_SESSION_STATUS_CAPABILITY,
  ApiToWorkerMessageSchema,
  MAX_WS_FRAME_BYTES,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from '@atlas/contracts';
import type {
  ApiToWorkerMessage,
  CommandDispatch,
  SessionExit,
  WorkerToApiMessage,
} from '@atlas/contracts';
import type { WorkerConfig } from './config.js';
import type { Journal } from './state/journal.js';
import { cloneRepository } from './repositories/clone.js';
import { CredentialExchange } from './repositories/credential.js';
import { initializeRepository } from './repositories/initialize.js';
import { SessionManager } from './sessions/manager.js';

// session.sync carries at most this many exits; the oldest are dropped first.
const MAX_MISSED_EXITS = 500;

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
  const active = new Map<string, CommandDispatch>();
  // Ended when the Worker stops, so a running clone does not hold up shutdown.
  const running = new AbortController();
  const send = (message: WorkerToApiMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const envelope = () => ({ protocolVersion: 1 as const, messageId: randomUUID() });
  // Pending credential requests by command ID. Requests are sent only on a registered connection.
  const credentials = new CredentialExchange((commandId) => {
    if (!registered || socket?.readyState !== WebSocket.OPEN) return false;
    send({ ...envelope(), type: 'credential.request', commandId, payload: {} });
    return true;
  });
  // Exits the API could not be told about, sent in the next session.sync. Output produced while
  // disconnected is dropped.
  const missedExits: SessionExit['payload'][] = [];
  const sessions = new SessionManager(config, (event) => {
    if (event.type === 'session.exit' && !registered) {
      missedExits.push(event.payload);
      if (missedExits.length > MAX_MISSED_EXITS) missedExits.shift();
      return;
    }
    send({ ...envelope(), ...event });
  });
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
  const dispatch = (command: CommandDispatch) => {
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
        // A clone still queued when the Worker stops is not started and gets no result; the API
        // dispatches it again after the next connection. Queued inits still run, as before.
        if (command.payload.kind === 'repository.clone' && running.signal.aborted) return;
        const context = {
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
        };
        const { payload } = command;
        // Both commands persist intent before the first filesystem mutation.
        const outcome =
          payload.kind === 'repository.init'
            ? await initializeRepository({ ...command, payload }, context)
            : await cloneRepository(
                { ...command, payload },
                {
                  ...context,
                  gitHostUrl: config.gitHostUrl,
                  requestCredential: credentials.request,
                  signal: running.signal,
                },
              );
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
          capabilities: [
            'repository.init',
            'agent.session',
            'repository.clone',
            AGENT_SESSION_STATUS_CAPABILITY,
          ],
        },
      });
    });
    current.on('message', (data, binary) => {
      let message: ApiToWorkerMessage;
      try {
        if (binary) throw new Error('Only JSON text is supported');
        message = ApiToWorkerMessageSchema.parse(JSON.parse(text(data)));
      } catch {
        // Parse errors can quote the message text, which may carry a credential: never log them.
        console.error('Invalid API message');
        current.close(1008);
        return;
      }
      try {
        if (message.type === 'worker.registered') {
          if (message.payload.workerId !== config.id) throw new Error('Worker identity mismatch');
          registered = true;
          attempts = 0;
          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            send({ ...envelope(), type: 'worker.heartbeat', payload: { workerId: config.id } });
            replay();
          }, message.payload.heartbeatIntervalMs);
          // First, so the API learns which sessions still run before anything else.
          send({
            ...envelope(),
            type: 'session.sync',
            payload: { sessions: sessions.snapshot(), exits: missedExits.splice(0) },
          });
          replay();
          console.log(`Worker ${config.name} connected`);
        } else if (message.type === 'command.dispatch') {
          if (!registered) throw new Error('Registration required');
          dispatch(message);
        } else if (message.type === 'credential.grant') {
          // Unknown or late grants are dropped; the token is never logged.
          if (registered) credentials.grant(message.commandId, message.payload);
        } else if (message.type === 'credential.refusal') {
          if (registered) credentials.refuse(message.commandId, message.payload);
        } else if (message.type === 'command.result_ack') {
          if (registered) journal.acknowledge(message.commandId);
        } else if (message.type === 'session.start') {
          if (!registered) throw new Error('Registration required');
          void sessions.start(message.payload);
        } else if (message.type === 'session.input') {
          const { sessionId, runId, data } = message.payload;
          sessions.input(sessionId, runId, data);
        } else if (message.type === 'session.resize') {
          sessions.resize(message.payload.sessionId, message.payload);
        } else if (message.type === 'session.stop') {
          sessions.stop(message.payload.sessionId, message.payload.runId);
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
      // A grant can only come over the connection that carried the request.
      credentials.dropAll();
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
      // End a running clone first; it reports needs_attention instead of holding up shutdown.
      running.abort();
      await queue;
      sessions.stopAll();
      registered = false;
      socket?.terminate();
    },
  };
}
