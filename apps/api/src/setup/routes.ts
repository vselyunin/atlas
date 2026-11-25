import { API_BASE_PATH, OwnerCodeSchema, SetupStartSchema } from '@atlas/contracts';
import type { SetupStartResponse } from '@atlas/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, parseInput } from '../http/errors.js';
import type { SetupService } from './service.js';

export const SETUP_STATE_COOKIE = 'atlas_setup_state';
export const SETUP_MARK_COOKIE = 'atlas_setup_mark';

const SETUP_GITHUB_PATH = `${API_BASE_PATH}/setup/github`;
// Sign-in, which reads the mark, lives under this path.
const MARK_PATH = `${API_BASE_PATH}/auth`;
const STATE_MAX_AGE_S = 60 * 60;
// The mark stops working on the server once an owner exists; the cookie only needs to outlive
// the time it takes to install the App and sign in.
const MARK_MAX_AGE_S = 30 * 24 * 60 * 60;
// Opens setup again for a browser while an owner exists and the App file is missing. Its path
// covers the setup routes and the auth state, which reports that setup is open to it.
export const SETUP_RECONNECT_COOKIE = 'atlas_setup_reconnect';
// Long enough to create an App on GitHub; the API ends it when the App file is written.
const RECONNECT_MAX_AGE_S = 24 * 60 * 60;
const OWNER_CODE_PATH = `${API_BASE_PATH}/setup/owner-code`;

// What lets a request without the owner's session reach a `setup` route while an owner exists:
// the reconnect mark, or, for the owner-code route, a reconnect code waiting to be entered.
export function reconnectAccess(setup: SetupService) {
  return (request: FastifyRequest) =>
    setup.hasReconnectMark(request.cookies[SETUP_RECONNECT_COOKIE]) ||
    (request.routeOptions.url === OWNER_CODE_PATH && setup.awaitsReconnectCode());
}

export function registerSetupRoutes(
  app: FastifyInstance,
  setup: SetupService,
  boardOrigin: string,
) {
  const secure = new URL(boardOrigin).protocol === 'https:';
  const stateCookie = { httpOnly: true, sameSite: 'lax', secure, path: SETUP_GITHUB_PATH } as const;
  const giveMark = (reply: FastifyReply, mark: string) =>
    reply.setCookie(SETUP_MARK_COOKIE, mark, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: MARK_PATH,
      maxAge: MARK_MAX_AGE_S,
    });

  // Returns the manifest form for the Board to post to GitHub, bound to this browser.
  app.post(
    `${SETUP_GITHUB_PATH}/start`,
    { config: { access: 'setup' } },
    (request, reply): SetupStartResponse => {
      const { organization } = parseInput(SetupStartSchema, request.body);
      const { response, cookie } = setup.start(organization);
      reply.header('cache-control', 'no-store');
      reply.setCookie(SETUP_STATE_COOKIE, cookie, { ...stateCookie, maxAge: STATE_MAX_AGE_S });
      return response;
    },
  );

  // GitHub returns here after the App is created. Its query string carries the manifest code and
  // `state`, so the request log omits it. No HEAD route: only a GET may use up a `state`.
  app.get(
    `${SETUP_GITHUB_PATH}/callback`,
    { config: { access: 'setup' }, exposeHeadRoute: false },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const text = (name: string) => {
        const value = query[name];
        return typeof value === 'string' ? value : undefined;
      };
      const result = await setup.finish({
        code: text('code'),
        state: text('state'),
        error: text('error'),
        cookie: request.cookies[SETUP_STATE_COOKIE],
      });
      reply.clearCookie(SETUP_STATE_COOKIE, stateCookie);
      if (result.mark) giveMark(reply, result.mark);
      // No error text: it could name the App file or carry details of the failure.
      if (result.unexpected) request.log.error('GitHub App setup failed with an unexpected error');
      const outcome = new URL(result.redirect).searchParams;
      request.log.info(
        { setup: outcome.get('setup'), reason: outcome.get('reason') ?? undefined },
        'GitHub App setup callback',
      );
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      return reply.redirect(result.redirect, 303);
    },
  );

  // Trades the one-time owner code, shown in the API's output, for a setup mark, or for a
  // reconnect mark while an owner exists and the App file is missing.
  app.post(OWNER_CODE_PATH, { config: { access: 'setup' } }, (request, reply) => {
    const { code } = parseInput(OwnerCodeSchema, request.body);
    const redeemed = setup.redeemOwnerCode(code);
    if (!redeemed) throw new ApiError(403, 'owner_code_invalid', 'The owner code is not valid');
    if (redeemed.purpose === 'owner') giveMark(reply, redeemed.mark);
    else
      reply.setCookie(SETUP_RECONNECT_COOKIE, redeemed.mark, {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: API_BASE_PATH,
        maxAge: RECONNECT_MAX_AGE_S,
      });
    reply.header('cache-control', 'no-store');
    return reply.code(204).send();
  });
}
