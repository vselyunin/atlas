import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  REGISTRATION_TIMEOUT_MS,
  WORKER_CONNECT_PATH,
  WorkerToApiMessageSchema,
} from '@atlas/contracts';
import type { ApiToWorkerMessage } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { ApiContext } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { applyAcceptance, applyResult, dispatchPending } from '../operations/service.js';
import type { SessionHub } from '../sessions/hub.js';
import type { WorkerRegistry } from './registry.js';

function validAuthorization(header: string | undefined, expected: Buffer) {
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseMessage(data: RawData, binary: boolean) {
  if (binary) throw new ApiError(400, 'invalid_message', 'Only JSON text messages are supported');
  let input: unknown;
  try {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data));
    input = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_message', 'Expected a JSON message');
  }
  if (
    typeof input === 'object' &&
    input !== null &&
    'protocolVersion' in input &&
    input.protocolVersion !== PROTOCOL_VERSION
  ) {
    throw new ApiError(400, 'unsupported_protocol_version', 'Unsupported Worker protocol version');
  }
  const message = WorkerToApiMessageSchema.safeParse(input);
  if (!message.success) throw new ApiError(400, 'invalid_message', 'Invalid Worker message');
  return message.data;
}

export function registerGateway(
  app: FastifyInstance,
  context: ApiContext,
  registry: WorkerRegistry,
  workerToken: string,
  sessions: SessionHub,
) {
  const authorization = Buffer.from(`Bearer ${workerToken}`);
  app.route({
    method: 'GET',
    url: WORKER_CONNECT_PATH,
    // The Worker authenticates with its token below, independent of sign-in.
    config: { access: 'worker' },
    preHandler(request, _reply, done) {
      if (!request.ws) return done(new ApiError(404, 'not_found', 'Unknown route'));
      if (request.headers.origin !== undefined)
        return done(
          new ApiError(403, 'origin_forbidden', 'Worker connections cannot use a browser Origin'),
        );
      if (!validAuthorization(request.headers.authorization, authorization)) {
        return done(
          new ApiError(403, 'worker_authentication_failed', 'Invalid Worker authorization'),
        );
      }
      done();
    },
    websocket: true,
    handler(socket, request) {
      let workerId: string | undefined;
      const send = (message: ApiToWorkerMessage) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify(message), (error) => {
            if (error) socket.terminate();
          });
      };
      const reportError = (code: string, message: string, commandId?: string) => {
        send({
          protocolVersion: PROTOCOL_VERSION,
          messageId: randomUUID(),
          type: 'protocol.error',
          payload: { code, message },
          ...(commandId ? { commandId } : {}),
        });
      };
      const registrationDeadline = setTimeout(() => {
        reportError('registration_timeout', 'Worker registration deadline expired');
        socket.close(1008);
      }, REGISTRATION_TIMEOUT_MS).unref();
      socket.on('close', () => {
        clearTimeout(registrationDeadline);
        if (!workerId) return;
        try {
          registry.disconnect(workerId, socket);
        } catch {
          request.log.error({ requestId: request.id }, 'Failed to persist Worker disconnection');
        }
      });
      socket.on('message', (data, binary) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        let commandId: string | undefined;
        try {
          const message = parseMessage(data, binary);
          if (!workerId) {
            if (message.type !== 'worker.register')
              throw new ApiError(400, 'registration_required', 'Register the Worker first');
            registry.register(socket, message.payload);
            workerId = message.payload.workerId;
            clearTimeout(registrationDeadline);
            send({
              protocolVersion: PROTOCOL_VERSION,
              messageId: randomUUID(),
              type: 'worker.registered',
              payload: { workerId, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS },
            });
            dispatchPending(context, registry, workerId);
            return;
          }
          switch (message.type) {
            case 'worker.register':
              throw new ApiError(
                409,
                'already_registered',
                'This connection already has a Worker identity',
              );
            case 'worker.heartbeat':
              if (message.payload.workerId !== workerId)
                throw new ApiError(
                  403,
                  'wrong_worker',
                  'Worker identity does not match registration',
                );
              registry.heartbeat(workerId);
              break;
            case 'command.accepted':
              commandId = message.commandId;
              applyAcceptance(context, workerId, commandId);
              break;
            case 'command.result':
              commandId = message.commandId;
              applyResult(context, workerId, message);
              send({
                protocolVersion: PROTOCOL_VERSION,
                messageId: randomUUID(),
                type: 'command.result_ack',
                commandId,
                payload: {},
              });
              break;
            case 'session.started':
              sessions.onStarted(workerId, message.payload);
              break;
            case 'session.output':
              sessions.onOutput(workerId, message.payload);
              break;
            case 'session.exit':
              sessions.onExit(workerId, message.payload);
              break;
            case 'protocol.error':
              request.log.info({ requestId: request.id }, 'Worker reported a protocol error');
              break;
          }
        } catch (error) {
          if (error instanceof ApiError) {
            reportError(error.code, error.message, commandId);
            if (!workerId || error.code === 'unsupported_protocol_version') socket.close(1008);
          } else {
            request.log.error({ requestId: request.id }, 'Unexpected Worker connection error');
            socket.close(1011);
          }
        }
      });
    },
  });
}
