import { API_BASE_PATH } from '@atlas/contracts';
import type { AuthStateResponse } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import type { ResolvedAuthOptions } from '../config.js';
import type { ApiContext } from '../db/client.js';
import type { AppFile } from '../github/app-file.js';
import { appInstallUrl } from '../github/urls.js';
import { hasOwner, readSessionUser } from './access.js';
import type { SessionStore } from './sessions.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  context: ApiContext,
  sessions: SessionStore,
  auth: ResolvedAuthOptions | undefined,
  appFile: AppFile | undefined,
) {
  // Tells the Board which page to show.
  app.get(
    `${API_BASE_PATH}/auth/state`,
    { config: { access: 'public' } },
    (request): AuthStateResponse => {
      if (!auth || !appFile) return { auth: 'off', setup: 'not_needed', user: null, app: null };
      const secrets = appFile.read();
      const setup = !secrets ? 'needed' : hasOwner(context) ? 'done' : 'needs_owner';
      const user = readSessionUser(request, sessions);
      // The setup page needs the App until an owner exists; after that only signed-in users see it.
      const app =
        secrets && (setup === 'needs_owner' || user)
          ? {
              name: secrets.name,
              account: secrets.account,
              installUrl: appInstallUrl(auth.githubWebUrl, secrets.slug),
            }
          : null;
      return { auth: 'github', setup, user, app };
    },
  );
}
