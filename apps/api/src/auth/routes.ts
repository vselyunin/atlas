import { API_BASE_PATH } from '@atlas/contracts';
import type { AuthStateResponse } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import type { ResolvedAuthOptions } from '../config.js';
import type { ApiContext } from '../db/client.js';
import { appFileExists, hasOwner, readSessionUser } from './access.js';
import type { SessionStore } from './sessions.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  context: ApiContext,
  sessions: SessionStore,
  auth: ResolvedAuthOptions | undefined,
) {
  // Tells the Board which page to show.
  app.get(
    `${API_BASE_PATH}/auth/state`,
    { config: { access: 'public' } },
    (request): AuthStateResponse => {
      if (!auth) return { auth: 'off', setup: 'not_needed', user: null, app: null };
      const setup = !appFileExists(auth) ? 'needed' : hasOwner(context) ? 'done' : 'needs_owner';
      return { auth: 'github', setup, user: readSessionUser(request, sessions), app: null };
    },
  );
}
