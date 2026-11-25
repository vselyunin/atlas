import { existsSync } from 'node:fs';
import type { User } from '@atlas/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ResolvedAuthOptions } from '../config.js';
import type { ApiContext } from '../db/client.js';
import { users } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { SESSION_COOKIE } from './sessions.js';
import type { SessionStore } from './sessions.js';

// Who may call a route while sign-in is on. A route without `access` requires a session.
// - public: anyone; the route reads the session itself if it needs one.
// - setup: anyone while the database has no owner, then only the owner.
// - worker: anyone; the Worker socket keeps its own token check.
// - owner: the owner's session.
export type RouteAccess = 'public' | 'setup' | 'worker' | 'owner';

export interface RouteListEntry {
  method: string;
  url: string;
  access: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyInstance {
    routeList: RouteListEntry[];
  }
}

// Records every route as it is added, so tests can check each route's access.
export function trackRoutes(app: FastifyInstance) {
  app.decorate('routeList', []);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods)
      app.routeList.push({ method, url: route.url, access: route.config?.access ?? 'session' });
  });
}

export function hasOwner({ db }: ApiContext) {
  return db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).get() !== undefined;
}

export function appFileExists(auth: ResolvedAuthOptions) {
  return existsSync(auth.appFile);
}

export function readSessionUser(request: FastifyRequest, sessions: SessionStore) {
  const rawId = request.cookies[SESSION_COOKIE];
  return rawId ? sessions.find(rawId) : null;
}

function requireOwner(user: User | null) {
  if (!user) return new ApiError(401, 'sign_in_required', 'Sign in to continue');
  if (user.role !== 'owner')
    return new ApiError(403, 'owner_required', 'Only the owner can do this');
  return undefined;
}

// Register after the cookie and CORS plugins: cookies are parsed and preflights answered by then.
export function registerAccess(
  app: FastifyInstance,
  context: ApiContext,
  sessions: SessionStore,
  auth: ResolvedAuthOptions | undefined,
) {
  app.decorateRequest('user', null);
  if (!auth) return;
  app.addHook('onRequest', (request, _reply, done) => {
    const access = request.routeOptions.config.access;
    if (access === 'public' || access === 'worker') return done();
    try {
      request.user = readSessionUser(request, sessions);
      if (access === 'setup')
        return done(hasOwner(context) ? requireOwner(request.user) : undefined);
      if (!appFileExists(auth))
        return done(new ApiError(409, 'setup_required', 'Atlas is not set up yet'));
      if (!request.user) return done(new ApiError(401, 'sign_in_required', 'Sign in to continue'));
      if (access === 'owner') return done(requireOwner(request.user));
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error('Access check failed'));
    }
  });
}
