import { API_BASE_PATH, BoardToApiSessionMessageSchema } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/sessions.js';
import type { SessionStore } from '../auth/sessions.js';
import { ApiError } from '../http/errors.js';
import type { SessionHub } from './hub.js';

// Spike: the Board attaches to a task's agent terminal over this socket.
// The route has no `access` value, so with sign-in on the upgrade requires a session.
// `authSessions` is given only while sign-in is on.
export function registerSessionRoutes(
  app: FastifyInstance,
  hub: SessionHub,
  allowedOrigin: string,
  authSessions?: SessionStore,
) {
  app.route<{ Params: { taskId: string } }>({
    method: 'GET',
    url: `${API_BASE_PATH}/tasks/:taskId/session`,
    preHandler(request, _reply, done) {
      if (!request.ws) return done(new ApiError(404, 'not_found', 'Unknown route'));
      // Terminal input runs commands on a worker, so only the Board's own origin may connect.
      if (request.headers.origin !== allowedOrigin)
        return done(new ApiError(403, 'origin_forbidden', 'This browser Origin is forbidden'));
      done();
    },
    websocket: true,
    handler(socket, request) {
      const { taskId } = request.params;
      // With sign-in on, the upgrade passed the session check; the socket lives only as long as
      // that session does.
      const rawId = request.cookies[SESSION_COOKIE];
      if (authSessions && request.user && rawId) {
        hub.watch(socket, request.user.id, () => authSessions.find(rawId) !== null);
      }
      hub.attach(taskId, socket);
      socket.on('close', () => hub.detach(taskId, socket));
      socket.on('message', (data, binary) => {
        try {
          if (binary) throw new ApiError(400, 'invalid_message', 'Expected a JSON message');
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(new Uint8Array(data));
          let input: unknown;
          try {
            input = JSON.parse(bytes.toString('utf8'));
          } catch {
            throw new ApiError(400, 'invalid_message', 'Expected a JSON message');
          }
          const message = BoardToApiSessionMessageSchema.safeParse(input);
          if (!message.success) throw new ApiError(400, 'invalid_message', 'Invalid message');
          switch (message.data.type) {
            case 'start':
              hub.start(taskId, { cols: message.data.cols, rows: message.data.rows });
              break;
            case 'input':
              hub.input(taskId, message.data.data);
              break;
            case 'resize':
              hub.resize(taskId, { cols: message.data.cols, rows: message.data.rows });
              break;
            case 'stop':
              hub.stop(taskId);
              break;
          }
        } catch (error) {
          if (!(error instanceof ApiError)) {
            request.log.error({ requestId: request.id }, 'Unexpected session socket error');
          }
          hub.deliver(socket, {
            type: 'error',
            message: error instanceof ApiError ? error.message : 'Unexpected session error',
          });
        }
      });
    },
  });
}
