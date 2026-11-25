import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStateResponseSchema } from '@atlas/contracts';
import SQLite from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { SessionStore } from '../src/auth/sessions.js';
import { openDatabase } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { BOARD_ORIGIN, WORKER_TOKEN, buildAuthApp, signIn } from './support/auth-app.js';
import { startGithubStandIn } from './support/github-stand-in.js';
import type { GithubStandIn } from './support/github-stand-in.js';

// An owner exists and the App file is gone, for example after "Remove the connection", and nobody
// holds the owner's session. The owner code printed at start opens setup again, and nothing
// else: the owner stays who they were.

const START = '/api/v1/setup/github/start';
const CALLBACK = '/api/v1/setup/github/callback';
const OWNER_CODE = '/api/v1/setup/owner-code';
const STATE = '/api/v1/auth/state';
const STATE_COOKIE = 'atlas_setup_state';
const MARK_COOKIE = 'atlas_setup_mark';
const RECONNECT_COOKIE = 'atlas_setup_reconnect';
const OWNER = { id: 101, login: 'the-owner' };
const OTHER = { id: 202, login: 'someone-else' };
const LONG = { timeout: 30_000 };

type Api = Awaited<ReturnType<typeof buildAuthApp>>;

let github: GithubStandIn;
const open: Api[] = [];

beforeAll(async () => {
  github = await startGithubStandIn();
});
afterAll(async () => {
  await github.close();
});
afterEach(async () => {
  for (const api of open.splice(0)) await api.close();
  Object.assign(github.state, {
    users: {},
    authorizeCode: null,
    manifestCodes: [],
    failWith: null,
    failWhen: undefined,
    requests: [],
  });
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function seedUsers(dbPath: string) {
  const database = openDatabase(dbPath, () => new Date().toISOString());
  try {
    for (const [id, account, role] of [
      ['u-owner', OWNER, 'owner'],
      ['u-member', { id: 303, login: 'a-member' }, 'member'],
    ] as const) {
      database.db
        .insert(users)
        .values({
          id,
          githubId: account.id,
          login: account.login,
          name: null,
          avatarUrl: null,
          role,
          createdAt: '2026-11-25T00:00:00.000Z',
        })
        .run();
    }
    const store = new SessionStore({ db: database.db, now: () => new Date().toISOString() });
    return { member: store.create('u-member') };
  } finally {
    database.close();
  }
}

// An installation whose owner exists and whose App file is missing.
async function buildReconnecting() {
  let member = '';
  const api = await buildAuthApp(
    {},
    {
      github,
      prepare: ({ dbPath }) => {
        member = seedUsers(dbPath).member;
      },
    },
  );
  open.push(api);
  return { api, member };
}

function rows(api: Api, sql: string) {
  const sqlite = new SQLite(join(api.directory, 'atlas.sqlite'), { readonly: true });
  try {
    return sqlite.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    sqlite.close();
  }
}

const installation = (api: Api) => rows(api, 'SELECT key, value FROM installation ORDER BY key');
const people = (api: Api) =>
  rows(api, 'SELECT id, githubId, login, role FROM users ORDER BY id').map((row) => ({ ...row }));

async function setupState(app: FastifyInstance, cookies: Record<string, string> = {}) {
  const response = await app.inject({ url: STATE, cookies });
  return AuthStateResponseSchema.parse(response.json()).setup;
}

async function redeem(api: Api, cookies: Record<string, string> = {}) {
  const response = await api.app.inject({
    method: 'POST',
    url: OWNER_CODE,
    payload: { code: api.ownerCodes[0] ?? '' },
    cookies,
  });
  return {
    response,
    mark: response.cookies.find((entry) => entry.name === RECONNECT_COOKIE)?.value ?? '',
  };
}

// Runs setup from the start route through the callback with the stand-in's manifest code.
async function runSetup(app: FastifyInstance, cookies: Record<string, string>) {
  const started = await app.inject({ method: 'POST', url: START, payload: {}, cookies });
  expect(started.statusCode).toBe(200);
  const state = new URL(started.json<{ action: string }>().action).searchParams.get('state') ?? '';
  const stateCookie = started.cookies.find((entry) => entry.name === STATE_COOKIE)?.value ?? '';
  github.state.manifestCodes.push('reconnect-code');
  return app.inject({
    url: `${CALLBACK}?${new URLSearchParams({ code: 'reconnect-code', state }).toString()}`,
    cookies: { ...cookies, [STATE_COOKIE]: stateCookie },
  });
}

describe('reconnecting after the App file was removed', () => {
  it('issues an owner code at start and stores only its hash', LONG, async () => {
    const { api } = await buildReconnecting();
    expect(api.ownerCodes).toHaveLength(1);
    const code = api.ownerCodes[0] ?? '';
    expect(code.length).toBeGreaterThanOrEqual(43);
    expect(installation(api)).toEqual([{ key: 'owner_code', value: sha256(code) }]);
  });

  it('tells a browser without the owner session to reconnect', LONG, async () => {
    const { api, member } = await buildReconnecting();
    const response = await api.app.inject(STATE);
    expect(AuthStateResponseSchema.parse(response.json())).toEqual({
      auth: 'github',
      setup: 'reconnect',
      user: null,
      app: null,
    });
    expect(await setupState(api.app, { atlas_session: member })).toBe('reconnect');
  });

  it('refuses the setup routes without the owner code', LONG, async () => {
    const { api, member } = await buildReconnecting();
    const requests = [
      { method: 'POST' as const, url: START, payload: {} },
      { method: 'GET' as const, url: `${CALLBACK}?code=x&state=y` },
    ];
    for (const request of requests) {
      const anonymous = await api.app.inject(request);
      expect(anonymous.statusCode, request.url).toBe(401);
      const forged = await api.app.inject({
        ...request,
        cookies: { [RECONNECT_COOKIE]: 'forged' },
      });
      expect(forged.statusCode, request.url).toBe(401);
      const asMember = await api.app.inject({ ...request, cookies: { atlas_session: member } });
      expect(asMember.statusCode, request.url).toBe(403);
      expect(asMember.json()).toMatchObject({ error: { code: 'owner_required' } });
    }
    const wrong = await api.app.inject({
      method: 'POST',
      url: OWNER_CODE,
      payload: { code: 'guess' },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ error: { code: 'owner_code_invalid' } });
    expect(wrong.cookies).toEqual([]);
    expect(existsSync(api.appFile)).toBe(false);
  });

  it('trades the code once for a reconnect mark that opens setup', LONG, async () => {
    const { api } = await buildReconnecting();
    const { response, mark } = await redeem(api);
    expect(response.statusCode).toBe(204);
    const cookie = response.cookies.find((entry) => entry.name === RECONNECT_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/v1' });
    // The setup mark, which makes a sign-in the owner, is not given.
    expect(response.cookies.find((entry) => entry.name === MARK_COOKIE)).toBeUndefined();
    expect(installation(api)).toEqual([{ key: 'reconnect_mark', value: sha256(mark) }]);

    expect(await setupState(api.app, { [RECONNECT_COOKIE]: mark })).toBe('needed');
    const reused = await redeem(api, { [RECONNECT_COOKIE]: mark });
    expect(reused.response.statusCode).toBe(403);
    expect(reused.response.json()).toMatchObject({ error: { code: 'owner_code_invalid' } });
    // Without the mark, a used code leaves nothing open.
    expect((await redeem(api)).response.statusCode).toBe(401);

    const started = await api.app.inject({
      method: 'POST',
      url: START,
      payload: {},
      cookies: { [RECONNECT_COOKIE]: mark },
    });
    expect(started.statusCode).toBe(200);
  });

  it('keeps the owner when a new App is saved, and lets only them back in', LONG, async () => {
    const { api } = await buildReconnecting();
    const before = people(api);
    const { mark } = await redeem(api);

    const done = await runSetup(api.app, { [RECONNECT_COOKIE]: mark });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe(`${BOARD_ORIGIN}/?setup=created`);
    expect(JSON.parse(readFileSync(api.appFile, 'utf8'))).toEqual(github.secrets);
    expect(done.cookies.find((entry) => entry.name === MARK_COOKIE)).toBeUndefined();
    // The code and the reconnect mark are gone; no setup mark was stored.
    expect(installation(api)).toEqual([]);
    expect(people(api)).toEqual(before);
    expect(await setupState(api.app)).toBe('done');

    // The mark opens nothing now that the App file exists.
    const again = await api.app.inject({
      method: 'POST',
      url: START,
      payload: {},
      cookies: { [RECONNECT_COOKIE]: mark },
    });
    expect(again.statusCode).toBe(401);

    // Another account, even from the browser that reconnected, is not let in.
    await expect(signIn(api.app, OTHER, { [RECONNECT_COOKIE]: mark })).rejects.toThrow(
      `${BOARD_ORIGIN}/?signin=failed&reason=no_access&login=${OTHER.login}`,
    );
    expect(people(api)).toEqual(before);

    // The owner signs in with their own account, as before.
    const cookie = await signIn(api.app, OWNER);
    const state = await api.app.inject({ url: STATE, headers: { cookie } });
    expect(state.json()).toMatchObject({
      setup: 'done',
      user: { id: 'u-owner', login: OWNER.login, role: 'owner' },
    });
    expect(people(api)).toEqual(before);
  });

  it('does not let a sign-in with the reconnect mark become a second owner', LONG, async () => {
    const { api } = await buildReconnecting();
    const { mark } = await redeem(api);
    await runSetup(api.app, { [RECONNECT_COOKIE]: mark });
    const owners = () => rows(api, "SELECT id FROM users WHERE role = 'owner'");
    await expect(
      signIn(api.app, OTHER, { [RECONNECT_COOKIE]: mark, [MARK_COOKIE]: mark }),
    ).rejects.toThrow(/no_access/);
    expect(owners()).toEqual([{ id: 'u-owner' }]);
  });
});

describe('with an owner and an App file', () => {
  it('issues no code and opens nothing without the owner session', LONG, async () => {
    const api = await buildAuthApp(
      {},
      {
        github,
        prepare: ({ appFile, dbPath }) => {
          writeFileSync(appFile, JSON.stringify(github.secrets), { mode: 0o600 });
          seedUsers(dbPath);
        },
      },
    );
    open.push(api);
    expect(api.ownerCodes).toEqual([]);
    expect(installation(api)).toEqual([]);
    expect(await setupState(api.app)).toBe('done');
    const code = await api.app.inject({
      method: 'POST',
      url: OWNER_CODE,
      payload: { code: 'anything' },
    });
    expect(code.statusCode).toBe(401);
    const started = await api.app.inject({
      method: 'POST',
      url: START,
      payload: {},
      cookies: { [RECONNECT_COOKIE]: 'anything' },
    });
    expect(started.statusCode).toBe(401);
  });
});

describe('the printed owner code', () => {
  let directory = '';
  afterEach(async () => {
    vi.restoreAllMocks();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('says that the connection is missing when it is for a reconnect', LONG, async () => {
    directory = await mkdtemp(join(tmpdir(), 'atlas-reconnect-'));
    const dbPath = join(directory, 'atlas.sqlite');
    seedUsers(dbPath);
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const app = await buildApp({
      dbPath,
      workerToken: WORKER_TOKEN,
      allowedOrigin: BOARD_ORIGIN,
      auth: {
        appFile: join(directory, 'github-app.json'),
        githubApiUrl: github.apiUrl,
        githubWebUrl: github.webUrl,
      },
    });
    try {
      const printed = lines.filter((line) => line.startsWith('Atlas owner code'));
      expect(printed).toHaveLength(1);
      expect(printed[0]).toMatch(
        /^Atlas owner code \(the GitHub connection is missing; enter it on the setup page to connect a new GitHub App\): \S{43,}\n$/,
      );
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  });
});
