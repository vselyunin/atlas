import { ErrorResponseSchema, MAX_WS_FRAME_BYTES } from '@atlas/contracts';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ApiOptions } from './config.js';
import { isLocalHost, validateOptions } from './config.js';
import { openDatabase } from './db/client.js';
import { ApiError, registerErrorHandlers } from './http/errors.js';
import { registerOperationRoutes } from './operations/routes.js';
import { registerProjectRoutes } from './projects/routes.js';
import { SessionHub } from './sessions/hub.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { registerVersionRoutes } from './versions/routes.js';
import { registerGateway } from './workers/gateway.js';
import { WorkerRegistry } from './workers/registry.js';
import { registerWorkerRoutes } from './workers/routes.js';

export type { ApiOptions } from './config.js';

export async function buildApp(options: ApiOptions): Promise<FastifyInstance> {
  const { dbPath, workerToken, allowedOrigin, now, logger } = validateOptions(options);
  const database = openDatabase(dbPath, now);
  const context = { db: database.db, now };
  const registry = new WorkerRegistry(context);
  const app = Fastify({ logger });
  app.addHook('onClose', (_app, done) => {
    database.close();
    done();
  });
  registerErrorHandlers(app);
  app.addHook('onRequest', (request, _reply, done) => {
    if (!isLocalHost(request.headers.host)) {
      return done(new ApiError(403, 'host_forbidden', 'API requests require a loopback Host'));
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== allowedOrigin) {
      return done(new ApiError(403, 'origin_forbidden', 'This browser Origin is forbidden'));
    }
    if (
      ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) &&
      request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    ) {
      return done(new ApiError(400, 'json_required', 'Send a JSON request body'));
    }
    done();
  });

  try {
    await app.register(cors, {
      origin: allowedOrigin,
      methods: ['GET', 'POST', 'PATCH'],
      allowedHeaders: ['Content-Type'],
      strictPreflight: false,
    });
    await app.register(websocket, {
      options: { maxPayload: MAX_WS_FRAME_BYTES },
      errorHandler(_error, socket, request) {
        request.log.info({ requestId: request.id }, 'Worker socket closed after a transport error');
        if (socket.readyState === socket.OPEN) socket.terminate();
      },
      preClose(done) {
        for (const socket of this.websocketServer.clients) socket.terminate();
        this.websocketServer.close(done);
      },
    });
    registerProjectRoutes(app, context, registry);
    registerVersionRoutes(app, context);
    registerWorkerRoutes(app, context);
    registerTaskRoutes(app, context);
    registerOperationRoutes(app, context);
    const sessions = new SessionHub(context, registry);
    registerSessionRoutes(app, sessions, allowedOrigin);
    registerGateway(app, context, registry, workerToken, sessions);
    // Fastify owns the error handlers; round-trip every expected HTTP error via the shared shape.
    app.addHook('preSerialization', (request, reply, payload, done) => {
      if (reply.statusCode >= 400) {
        const checked = ErrorResponseSchema.safeParse(payload);
        if (!checked.success) {
          request.log.error({ requestId: request.id }, 'Invalid API error response');
          reply.code(500);
          return done(null, { error: { code: 'internal_error', message: 'Unexpected API error' } });
        }
      }
      done(null, payload);
    });
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
