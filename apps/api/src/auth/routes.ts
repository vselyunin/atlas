import { API_BASE_PATH } from '@atlas/contracts';
import type { AuthStateResponse } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import type { ResolvedAuthOptions } from '../config.js';
import type { ApiContext } from '../db/client.js';
import type { AppFile } from '../github/app-file.js';
import { appInstallUrl } from '../github/urls.js';
import { SETUP_MARK_COOKIE } from '../setup/routes.js';
import { hasOwner, readSessionUser } from './access.js';
import { SESSION_COOKIE } from './sessions.js';
import type { SessionStore } from './sessions.js';
import { SIGNIN_LIFETIME_MS, SIGNIN_PATH } from './signin.js';
import type { SignInService } from './signin.js';

export const SIGNIN_COOKIE = 'atlas_signin';
// The server ends a session 30 days after its last use. The cookie outlives that so that a
// session in use is not dropped by the browser; 400 days is the longest browsers keep a cookie.
const SESSION_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

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

// Sign-in with GitHub and sign-out. Registered only while sign-in is on.
export function registerSignInRoutes(
  app: FastifyInstance,
  signin: SignInService,
  sessions: SessionStore,
  boardOrigin: string,
  // Called with the user whose session was signed out, so their sockets can be checked at once.
  onSignedOut: (userId: string) => void = () => undefined,
) {
  const secure = new URL(boardOrigin).protocol === 'https:';
  const signinCookie = { httpOnly: true, sameSite: 'lax', secure, path: SIGNIN_PATH } as const;
  const sessionCookie = { httpOnly: true, sameSite: 'lax', secure, path: '/' } as const;

  // The Board links here. No HEAD route: a start is only ever a browser navigation.
  app.get(
    `${SIGNIN_PATH}/start`,
    { config: { access: 'public' }, exposeHeadRoute: false },
    (_request, reply) => {
      const { redirect, cookie } = signin.start();
      reply.setCookie(SIGNIN_COOKIE, cookie, {
        ...signinCookie,
        maxAge: SIGNIN_LIFETIME_MS / 1000,
      });
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      return reply.redirect(redirect, 303);
    },
  );

  // GitHub returns here. Its query string carries the code and `state`, so the request log omits
  // it. Every outcome, an unexpected error included, is a redirect to the Board.
  app.get(
    `${SIGNIN_PATH}/callback`,
    { config: { access: 'public' }, exposeHeadRoute: false },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const text = (name: string) => {
        const value = query[name];
        return typeof value === 'string' ? value : undefined;
      };
      const result = await signin.finish({
        code: text('code'),
        state: text('state'),
        error: text('error'),
        cookie: request.cookies[SIGNIN_COOKIE],
        mark: request.cookies[SETUP_MARK_COOKIE],
        currentSession: request.cookies[SESSION_COOKIE],
      });
      reply.clearCookie(SIGNIN_COOKIE, signinCookie);
      if (result.session) {
        reply.setCookie(SESSION_COOKIE, result.session, {
          ...sessionCookie,
          maxAge: SESSION_COOKIE_MAX_AGE_S,
        });
      }
      // No error text: it could carry details of the failure.
      if (result.unexpected) request.log.error('GitHub sign-in failed with an unexpected error');
      const outcome = new URL(result.redirect).searchParams;
      request.log.info(
        { signin: outcome.get('signin') ?? 'done', reason: outcome.get('reason') ?? undefined },
        'GitHub sign-in callback',
      );
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      return reply.redirect(result.redirect, 303);
    },
  );

  // A POST with a JSON body: the request hook refuses other content types and foreign Origins,
  // so another site cannot sign a browser out.
  app.post(`${API_BASE_PATH}/auth/sign-out`, { config: { access: 'public' } }, (request, reply) => {
    const rawId = request.cookies[SESSION_COOKIE];
    const user = rawId ? sessions.find(rawId) : null;
    if (rawId) sessions.delete(rawId);
    if (user) onSignedOut(user.id);
    reply.clearCookie(SESSION_COOKIE, sessionCookie);
    reply.header('cache-control', 'no-store');
    return reply.code(204).send();
  });
}
