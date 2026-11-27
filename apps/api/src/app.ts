import { ErrorResponseSchema, MAX_WS_FRAME_BYTES } from '@atlas/contracts';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerAccess, trackRoutes } from './auth/access.js';
import { registerMemberRoutes } from './auth/members.js';
import { registerAuthRoutes, registerSignInRoutes } from './auth/routes.js';
import { SessionStore } from './auth/sessions.js';
import { SignInService } from './auth/signin.js';
import type { ApiOptions } from './config.js';
import { isLocalHost, validateOptions } from './config.js';
import { openDatabase } from './db/client.js';
import { AppFile } from './github/app-file.js';
import { GitHubClient } from './github/client.js';
import { CredentialBroker } from './github/credentials.js';
import { LinkService } from './github/links.js';
import { registerGithubRoutes, registerGithubUnavailableRoutes } from './github/routes.js';
import { ApiError, registerErrorHandlers } from './http/errors.js';
import { loggerOptions } from './http/log.js';
import { registerOperationRoutes } from './operations/routes.js';
import { registerProjectRoutes } from './projects/routes.js';
import { SessionHub } from './sessions/hub.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { reconnectAccess, registerSetupRoutes } from './setup/routes.js';
import { SetupService, assertAppFileOutsideWorkspaces } from './setup/service.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { registerVersionRoutes } from './versions/routes.js';
import { registerGateway } from './workers/gateway.js';
import { WorkerRegistry } from './workers/registry.js';
import { registerWorkerRoutes } from './workers/routes.js';

export type { ApiOptions, AuthOptions } from './config.js';

export async function buildApp(options: ApiOptions): Promise<FastifyInstance> {
  const { dbPath, workerToken, allowedOrigin, now, logger, logStream, auth, sessionRecheckMs } =
    validateOptions(options);
  const database = openDatabase(dbPath, now);
  const context = { db: database.db, now };
  const registry = new WorkerRegistry(context);
  const app = Fastify({ logger: loggerOptions(logger, logStream) });
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
  trackRoutes(app);
  const authSessions = new SessionStore(context);
  const appFile = auth ? new AppFile(auth.appFile) : undefined;
  const github = auth
    ? new GitHubClient({ apiUrl: auth.githubApiUrl, webUrl: auth.githubWebUrl })
    : undefined;
  const setup =
    appFile && github && auth
      ? new SetupService({
          context,
          appFile,
          github,
          boardOrigin: allowedOrigin,
          webUrl: auth.githubWebUrl,
        })
      : undefined;

  try {
    if (appFile) {
      assertAppFileOutsideWorkspaces(context, appFile);
      // Throws with the file's path when the file exists but is not a valid App file.
      appFile.read();
    }
    await app.register(cors, {
      origin: allowedOrigin,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type'],
      strictPreflight: false,
    });
    await app.register(cookie);
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
    const sessions = new SessionHub(context, registry, sessionRecheckMs);
    app.addHook('onClose', (_app, done) => {
      sessions.close();
      done();
    });
    const projectGithub = appFile && github ? { appFile, client: github } : undefined;
    const broker = new CredentialBroker({ context, log: app.log, github: projectGithub });
    // Revokes held credentials, best-effort; each revocation is bounded by the GitHub timeout.
    app.addHook('onClose', async () => {
      await broker.close();
    });
    // Removing a member closes their open Board session sockets at once.
    authSessions.onUserRemoved((userId) => sessions.closeForUser(userId));
    const reconnect = setup ? reconnectAccess(setup) : undefined;
    registerAccess(app, context, authSessions, appFile, reconnect);
    registerAuthRoutes(app, context, authSessions, auth, appFile, reconnect);
    if (setup && appFile && github && auth) {
      registerSetupRoutes(app, setup, allowedOrigin);
      registerGithubRoutes(
        app,
        appFile,
        github,
        auth.githubWebUrl,
        new LinkService(context, appFile, github),
      );
      const signin = new SignInService({
        context,
        appFile,
        github,
        sessions: authSessions,
        setup,
        boardOrigin: allowedOrigin,
      });
      registerSignInRoutes(app, signin, authSessions, allowedOrigin, (userId) =>
        sessions.recheckUser(userId),
      );
      registerMemberRoutes(app, context, authSessions);
    } else {
      registerGithubUnavailableRoutes(app);
    }
    registerProjectRoutes(app, context, registry, broker, projectGithub);
    registerVersionRoutes(app, context);
    registerWorkerRoutes(app, context);
    registerTaskRoutes(app, context, sessions);
    registerOperationRoutes(app, context);
    registerSessionRoutes(app, sessions, allowedOrigin, appFile ? authSessions : undefined);
    registerGateway(app, context, registry, workerToken, sessions, broker);
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
    // Shown to the person running the API, never through the request log.
    const ownerCode = setup?.openOwnerCode();
    if (ownerCode && auth) auth.ownerCodeSink(ownerCode.code, ownerCode.purpose);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
