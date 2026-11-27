import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import SQLite from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOARD_ORIGIN, buildAuthApp, signIn } from './support/auth-app.js';
import type { AuthAppExtras } from './support/auth-app.js';
import { startGithubStandIn } from './support/github-stand-in.js';
import type { GithubStandIn } from './support/github-stand-in.js';

const START = '/api/v1/auth/github/start';
const CALLBACK = '/api/v1/auth/github/callback';
const SIGN_OUT = '/api/v1/auth/sign-out';
const SIGNIN_COOKIE = 'atlas_signin';
const SESSION_COOKIE = 'atlas_session';
const MARK_COOKIE = 'atlas_setup_mark';
const DAY = 24 * 60 * 60 * 1000;
const OWNER = { id: 101, login: 'the-owner' };
const OTHER = { id: 202, login: 'someone-else' };

type Api = Awaited<ReturnType<typeof buildAuthApp>>;

let github: GithubStandIn;
let api: Api;
let time: number;
let logLines: string[];

beforeAll(async () => {
  github = await startGithubStandIn();
});
afterAll(async () => {
  await github.close();
});

function resetStandIn() {
  Object.assign(github.state, {
    users: {},
    authorizeCode: null,
    failWith: null,
    failWhen: undefined,
    requests: [],
  });
}

function build(overrides: Parameters<typeof buildAuthApp>[0] = {}, extras: AuthAppExtras = {}) {
  time = Date.parse('2026-11-25T10:00:00.000Z');
  logLines = [];
  return buildAuthApp(
    {
      now: () => new Date(time),
      logStream: { write: (line: string) => void logLines.push(line) },
      ...overrides,
    },
    {
      github,
      prepare: ({ appFile }) =>
        writeFileSync(appFile, JSON.stringify(github.secrets), { mode: 0o600 }),
      ...extras,
    },
  );
}

// Trades the owner code printed at start for a setup mark, as the sign-in page does.
async function setupMark(target: Api) {
  const response = await target.app.inject({
    method: 'POST',
    url: '/api/v1/setup/owner-code',
    payload: { code: target.ownerCodes[0] ?? '' },
  });
  const mark = response.cookies.find((entry) => entry.name === MARK_COOKIE)?.value;
  if (!mark) throw new Error('No setup mark');
  return mark;
}

async function start(app: FastifyInstance) {
  const response = await app.inject({ url: START });
  const location = new URL(String(response.headers.location));
  const cookie = response.cookies.find((entry) => entry.name === SIGNIN_COOKIE);
  return {
    response,
    location,
    state: location.searchParams.get('state') ?? '',
    challenge: location.searchParams.get('code_challenge') ?? '',
    cookie: cookie?.value ?? '',
    setCookie: cookie,
  };
}

// Registers a sign-in code for `user` at the stand-in, as GitHub's authorize page would. The
// stand-in is shared by the tests and accepts a code once, so every code is new.
function codeFor(user: { id: number; login: string }, name: string) {
  const code = `${name}-${randomBytes(6).toString('hex')}`;
  github.state.users[code] = { id: user.id, login: user.login, name: 'Name', avatarUrl: null };
  return code;
}

function callback(
  app: FastifyInstance,
  query: Record<string, string>,
  cookies: Record<string, string> = {},
) {
  return app.inject({ url: `${CALLBACK}?${new URLSearchParams(query).toString()}`, cookies });
}

function failedTo(reason: string, login?: string) {
  return `${BOARD_ORIGIN}/?signin=failed&reason=${reason}${login === undefined ? '' : `&login=${login}`}`;
}

function sessionOf(response: Awaited<ReturnType<typeof callback>>) {
  return response.cookies.find((entry) => entry.name === SESSION_COOKIE);
}

function rows(target: Api, table: string) {
  const sqlite = new SQLite(`${target.directory}/atlas.sqlite`, { readonly: true });
  try {
    return sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } finally {
    sqlite.close();
  }
}

function everyStoredValue(target: Api) {
  const sqlite = new SQLite(`${target.directory}/atlas.sqlite`, { readonly: true });
  try {
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    return tables.flatMap(({ name }) =>
      (sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]).flatMap(
        (row) => Object.values(row).map((value) => String(value)),
      ),
    );
  } finally {
    sqlite.close();
  }
}

const projects = (app: FastifyInstance, cookie: string) =>
  app.inject({ url: '/api/v1/projects', headers: { cookie } });

describe('signing in', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    resetStandIn();
    api = await build();
  }, 30_000);
  afterEach(async () => {
    await api.close();
  });

  it('starts with PKCE and a state bound to this browser', async () => {
    const { response, location, state, challenge, setCookie } = await start(api.app);
    expect(response.statusCode).toBe(303);
    expect(`${location.origin}${location.pathname}`).toBe(`${github.webUrl}/login/oauth/authorize`);
    expect(location.searchParams.get('client_id')).toBe(github.secrets.clientId);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('redirect_uri')).toBe(`${BOARD_ORIGIN}${CALLBACK}`);
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 600,
      path: '/api/v1/auth/github',
    });
    expect(setCookie?.secure).toBeFalsy();
    expect(response.headers['cache-control']).toBe('no-store');
    // Two starts give two different states.
    expect((await start(api.app)).state).not.toBe(state);
  });

  it('refuses a callback with another state, without the cookie, or replayed', async () => {
    const mark = await setupMark(api);
    const first = await start(api.app);
    const second = await start(api.app);
    const crossed = await callback(
      api.app,
      { code: codeFor(OWNER, 'code-a'), state: second.state },
      { [SIGNIN_COOKIE]: first.cookie, [MARK_COOKIE]: mark },
    );
    expect(crossed.statusCode).toBe(303);
    expect(crossed.headers.location).toBe(failedTo('state_invalid'));
    expect(sessionOf(crossed)).toBeUndefined();

    const third = await start(api.app);
    const withoutCookie = await callback(
      api.app,
      { code: codeFor(OWNER, 'code-b'), state: third.state },
      { [MARK_COOKIE]: mark },
    );
    expect(withoutCookie.headers.location).toBe(failedTo('state_invalid'));
    // No code was sent to GitHub for the refused callbacks.
    expect(github.state.requests).toEqual([]);
    // Every outcome clears the sign-in cookie.
    expect(withoutCookie.cookies.find((entry) => entry.name === SIGNIN_COOKIE)).toMatchObject({
      value: '',
      path: '/api/v1/auth/github',
    });

    const fourth = await start(api.app);
    const code = codeFor(OWNER, 'code-c');
    github.state.authorizeCode = code;
    const page = await fetch(fourth.location, { redirect: 'manual' });
    const back = new URL(page.headers.get('location') ?? '');
    const query = Object.fromEntries(back.searchParams);
    const done = await callback(api.app, query, {
      [SIGNIN_COOKIE]: fourth.cookie,
      [MARK_COOKIE]: mark,
    });
    expect(done.headers.location).toBe(`${BOARD_ORIGIN}/`);
    expect(sessionOf(done)?.value).toBeTruthy();
    const replay = await callback(api.app, query, {
      [SIGNIN_COOKIE]: fourth.cookie,
      [MARK_COOKIE]: mark,
    });
    expect(replay.headers.location).toBe(failedTo('state_invalid'));
    expect(sessionOf(replay)?.value ?? '').toBe('');

    // The code went to GitHub with the verifier that matches the challenge.
    const exchanges = github.state.requests.filter(
      (request) => request.path === '/login/oauth/access_token',
    );
    expect(exchanges).toHaveLength(1);
    const body = exchanges[0]?.body as Record<string, unknown>;
    expect(body.code).toBe(code);
    expect(body.redirect_uri).toBe(`${BOARD_ORIGIN}${CALLBACK}`);
    expect(typeof body.code_verifier).toBe('string');
    expect(createHash('sha256').update(String(body.code_verifier)).digest('base64url')).toBe(
      fourth.challenge,
    );
  });

  it('refuses a state older than ten minutes', async () => {
    const mark = await setupMark(api);
    const { state, cookie } = await start(api.app);
    time += 10 * 60 * 1000 + 1000;
    const response = await callback(
      api.app,
      { code: codeFor(OWNER, 'code-a'), state },
      { [SIGNIN_COOKIE]: cookie, [MARK_COOKIE]: mark },
    );
    expect(response.headers.location).toBe(failedTo('state_invalid'));
  });

  it('gives an HttpOnly Lax session cookie and stores neither its ID nor the token', async () => {
    const mark = await setupMark(api);
    const { state, cookie } = await start(api.app);
    const code = codeFor(OWNER, 'code-a');
    const response = await callback(
      api.app,
      { code, state },
      { [SIGNIN_COOKIE]: cookie, [MARK_COOKIE]: mark },
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`${BOARD_ORIGIN}/`);
    expect(response.headers['cache-control']).toBe('no-store');
    const session = sessionOf(response);
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(session?.secure).toBeFalsy();
    const rawId = session?.value ?? '';
    expect(rawId.length).toBeGreaterThanOrEqual(43);

    const userRequest = github.state.requests.find((request) => request.path === '/api/user');
    const token = /^Bearer (.+)$/.exec(userRequest?.authorization ?? '')?.[1] ?? '';
    expect(token).toMatch(/^ghu_/);
    // The token was revoked at GitHub after reading the account.
    expect(github.state.userTokens.has(token)).toBe(false);

    const values = everyStoredValue(api);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).not.toContain(rawId);
      expect(value).not.toContain(token);
    }

    expect((await projects(api.app, `${SESSION_COOKIE}=${rawId}`)).statusCode).toBe(200);

    const log = logLines.join('');
    expect(log).toContain(CALLBACK);
    const verifier = cookie.split('.')[1] ?? 'missing';
    for (const secret of [state, verifier, code, rawId, token, mark, github.secrets.clientSecret])
      expect(log).not.toContain(secret);
  });

  it('gives a new session ID at every sign-in and ends the session it replaces', async () => {
    const mark = await setupMark(api);
    const first = await signIn(api.app, OWNER, { [MARK_COOKIE]: mark });
    const firstId = first.split('=')[1] ?? '';
    const second = await signIn(api.app, OWNER, { [SESSION_COOKIE]: firstId });
    expect(second).not.toBe(first);
    expect((await projects(api.app, second)).statusCode).toBe(200);
    expect((await projects(api.app, first)).statusCode).toBe(401);
    expect(rows(api, 'auth_sessions')).toHaveLength(1);
  });

  it('makes the first sign-in with the setup mark the owner and then retires the mark', async () => {
    const mark = await setupMark(api);
    await signIn(api.app, OWNER, { [MARK_COOKIE]: mark });
    expect(rows(api, 'users')).toEqual([
      expect.objectContaining({ githubId: OWNER.id, login: OWNER.login, role: 'owner' }),
    ]);
    expect(rows(api, 'installation')).toEqual([]);

    // The mark no longer makes anyone the owner or a member.
    const { state, cookie } = await start(api.app);
    const other = await callback(
      api.app,
      { code: codeFor(OTHER, 'code-other'), state },
      { [SIGNIN_COOKIE]: cookie, [MARK_COOKIE]: mark },
    );
    expect(other.headers.location).toBe(failedTo('no_access', OTHER.login));
    expect(sessionOf(other)?.value ?? '').toBe('');
    expect(rows(api, 'users')).toHaveLength(1);
    expect(rows(api, 'auth_sessions')).toHaveLength(1);
  });

  it('makes nobody the owner without the setup mark', async () => {
    const { state, cookie } = await start(api.app);
    const response = await callback(
      api.app,
      { code: codeFor(OWNER, 'code-a'), state },
      { [SIGNIN_COOKIE]: cookie, [MARK_COOKIE]: 'not-the-mark' },
    );
    expect(response.headers.location).toBe(failedTo('no_access', OWNER.login));
    expect(rows(api, 'users')).toEqual([]);
    expect(rows(api, 'auth_sessions')).toEqual([]);
    const state2 = await api.app.inject('/api/v1/auth/state');
    expect(state2.json()).toMatchObject({ setup: 'needs_owner', user: null });
  });

  it('lets only one of two racing first sign-ins become the owner', async () => {
    const mark = await setupMark(api);
    const first = await start(api.app);
    const second = await start(api.app);
    const responses = await Promise.all([
      callback(
        api.app,
        { code: codeFor(OWNER, 'code-a'), state: first.state },
        { [SIGNIN_COOKIE]: first.cookie, [MARK_COOKIE]: mark },
      ),
      callback(
        api.app,
        { code: codeFor(OTHER, 'code-b'), state: second.state },
        { [SIGNIN_COOKIE]: second.cookie, [MARK_COOKIE]: mark },
      ),
    ]);
    const succeeded = responses.filter((response) => sessionOf(response)?.value);
    expect(succeeded).toHaveLength(1);
    const owners = rows(api, 'users').filter((row) => row.role === 'owner');
    expect(owners).toHaveLength(1);
    expect(rows(api, 'users')).toHaveLength(1);
  });

  it('names the GitHub account it refused, encoded', async () => {
    const mark = await setupMark(api);
    await signIn(api.app, OWNER, { [MARK_COOKIE]: mark });
    const { state, cookie } = await start(api.app);
    const odd = { id: 303, login: 'a&b=c d' };
    const response = await callback(
      api.app,
      { code: codeFor(odd, 'code-odd'), state },
      { [SIGNIN_COOKIE]: cookie },
    );
    expect(response.headers.location).toBe(failedTo('no_access', 'a%26b%3Dc+d'));
    expect(new URL(String(response.headers.location)).searchParams.get('login')).toBe(odd.login);
  });

  it('reports a cancel on GitHub', async () => {
    const { state, cookie } = await start(api.app);
    const response = await callback(
      api.app,
      { error: 'access_denied', state },
      { [SIGNIN_COOKIE]: cookie },
    );
    expect(response.headers.location).toBe(failedTo('cancelled'));
    expect(sessionOf(response)?.value ?? '').toBe('');
  });

  it('reports GitHub failing and keeps existing sessions', async () => {
    const mark = await setupMark(api);
    const existing = await signIn(api.app, OWNER, { [MARK_COOKIE]: mark });
    github.state.failWith = 500;
    const { state, cookie } = await start(api.app);
    const response = await callback(
      api.app,
      { code: codeFor(OWNER, 'code-fail'), state },
      { [SIGNIN_COOKIE]: cookie },
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(failedTo('github_failed'));
    github.state.failWith = null;
    expect((await projects(api.app, existing)).statusCode).toBe(200);
  });

  it('ends a session 30 days after its last use', async () => {
    const mark = await setupMark(api);
    const idle = await signIn(api.app, OWNER, { [MARK_COOKIE]: mark });
    const used = await signIn(api.app, OWNER);
    time += 29 * DAY;
    expect((await projects(api.app, used)).statusCode).toBe(200);
    time += DAY + 1000;
    expect((await projects(api.app, idle)).statusCode).toBe(401);
    time += 10 * DAY - 1000;
    expect((await projects(api.app, used)).statusCode).toBe(200);
  });

  it('signs out with a POST only', async () => {
    const mark = await setupMark(api);
    const cookie = await signIn(api.app, OWNER, { [MARK_COOKIE]: mark });
    const viaGet = await api.app.inject({ url: SIGN_OUT, headers: { cookie } });
    expect(viaGet.statusCode).toBe(404);
    const viaForm = await api.app.inject({
      method: 'POST',
      url: SIGN_OUT,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(viaForm.statusCode).toBe(400);
    const foreign = await api.app.inject({
      method: 'POST',
      url: SIGN_OUT,
      headers: { cookie, origin: 'http://evil.localhost:5173' },
      payload: {},
    });
    expect(foreign.statusCode).toBe(403);
    expect((await projects(api.app, cookie)).statusCode).toBe(200);

    const response = await api.app.inject({
      method: 'POST',
      url: SIGN_OUT,
      headers: { cookie, origin: BOARD_ORIGIN },
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    expect(sessionOf(response)).toMatchObject({ value: '', path: '/' });
    expect(rows(api, 'auth_sessions')).toEqual([]);
    expect((await projects(api.app, cookie)).statusCode).toBe(401);
    // Signing out without a session is not an error.
    const again = await api.app.inject({ method: 'POST', url: SIGN_OUT, payload: {} });
    expect(again.statusCode).toBe(204);
  });
});

describe('signing in on an https Board origin', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    resetStandIn();
    api = await build({ allowedOrigin: 'https://localhost:5173' });
  }, 30_000);
  afterEach(async () => {
    await api.close();
  });

  it('marks the sign-in and session cookies Secure', async () => {
    const mark = await setupMark(api);
    const { state, cookie, setCookie, location } = await start(api.app);
    expect(setCookie?.secure).toBe(true);
    expect(location.searchParams.get('redirect_uri')).toBe(`https://localhost:5173${CALLBACK}`);
    const response = await callback(
      api.app,
      { code: codeFor(OWNER, 'code-a'), state },
      { [SIGNIN_COOKIE]: cookie, [MARK_COOKIE]: mark },
    );
    expect(response.headers.location).toBe('https://localhost:5173/');
    expect(sessionOf(response)).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: true });
  });
});
