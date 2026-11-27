import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStateResponseSchema, GithubConnectionResponseSchema } from '@atlas/contracts';
import SQLite from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/auth/sessions.js';
import { openDatabase } from '../src/db/client.js';
import { users, workers } from '../src/db/schema.js';
import { buildManifest } from '../src/setup/manifest.js';
import { BOARD_ORIGIN, TEST_APP_SECRETS, buildAuthApp } from './support/auth-app.js';
import type { AuthAppExtras } from './support/auth-app.js';
import { startGithubStandIn } from './support/github-stand-in.js';
import type { GithubStandIn } from './support/github-stand-in.js';

const STATE_COOKIE = 'atlas_setup_state';
const MARK_COOKIE = 'atlas_setup_mark';
const START = '/api/v1/setup/github/start';
const CALLBACK = '/api/v1/setup/github/callback';
const OWNER_CODE = '/api/v1/setup/owner-code';
const RIGHTS = { contents: 'write', pull_requests: 'write', metadata: 'read' };
const HOUR = 60 * 60 * 1000;

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
    appPublic: false,
    appPermissions: { ...RIGHTS },
    appEvents: [],
    manifestCodes: [],
    failWith: null,
    appOwnerType: 'Organization',
    failWhen: undefined,
    requests: [],
  });
}

async function build(extras: AuthAppExtras = {}, allowedOrigin = BOARD_ORIGIN) {
  time = Date.parse('2026-11-25T10:00:00.000Z');
  logLines = [];
  return buildAuthApp(
    {
      allowedOrigin,
      now: () => new Date(time),
      logStream: { write: (line: string) => void logLines.push(line) },
    },
    { github: { apiUrl: github.apiUrl, webUrl: github.webUrl }, ...extras },
  );
}

async function start(app: FastifyInstance, cookies: Record<string, string> = {}, body = {}) {
  const response = await app.inject({ method: 'POST', url: START, payload: body, cookies });
  if (response.statusCode !== 200) return { response, state: '', cookie: '' };
  const action = new URL(response.json<{ action: string }>().action);
  const cookie = response.cookies.find((entry) => entry.name === STATE_COOKIE)?.value ?? '';
  return { response, state: action.searchParams.get('state') ?? '', cookie };
}

function callback(
  app: FastifyInstance,
  query: Record<string, string>,
  cookies: Record<string, string> = {},
) {
  return app.inject({ url: `${CALLBACK}?${new URLSearchParams(query).toString()}`, cookies });
}

function failedTo(reason: string) {
  return `${BOARD_ORIGIN}/?setup=failed&reason=${reason}`;
}

function installationRows(target: Api) {
  const sqlite = new SQLite(target.directory + '/atlas.sqlite', { readonly: true });
  try {
    return sqlite.prepare('SELECT key, value FROM installation').all() as {
      key: string;
      value: string;
    }[];
  } finally {
    sqlite.close();
  }
}

function expectNothingWritten(response: Awaited<ReturnType<typeof callback>>) {
  expect(existsSync(api.appFile)).toBe(false);
  expect(response.cookies.find((entry) => entry.name === MARK_COOKIE)).toBeUndefined();
  expect(installationRows(api)).toEqual([]);
}

// Adds an owner and a member with sessions, the way sign-in will.
function addUsers(target: Api) {
  const now = () => new Date(time).toISOString();
  const database = openDatabase(target.directory + '/atlas.sqlite', now);
  try {
    for (const [id, role] of [
      ['u-owner', 'owner'],
      ['u-member', 'member'],
    ] as const) {
      database.db
        .insert(users)
        .values({
          id,
          githubId: null,
          login: id,
          name: null,
          avatarUrl: null,
          role,
          createdAt: now(),
        })
        .run();
    }
    const store = new SessionStore({ db: database.db, now });
    return { owner: store.create('u-owner'), member: store.create('u-member') };
  } finally {
    database.close();
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('setup with no App file and no owner', () => {
  beforeEach(async () => {
    resetStandIn();
    api = await build();
  });
  afterEach(async () => {
    await api.close();
  });

  it('returns a manifest form bound to this browser by an HttpOnly cookie', async () => {
    const { response, state, cookie } = await start(api.app);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ action: string; manifest: string }>();
    expect(body.action.startsWith(`${github.webUrl}/settings/apps/new?state=`)).toBe(true);
    expect(state.length).toBeGreaterThanOrEqual(32);
    const manifest = JSON.parse(body.manifest) as Record<string, unknown>;
    expect(manifest.public).toBe(false);
    expect(manifest).not.toHaveProperty('hook_attributes');
    expect(manifest).not.toHaveProperty('default_events');
    expect(manifest.default_permissions).toEqual(RIGHTS);
    expect(manifest.redirect_url).toBe(`${BOARD_ORIGIN}/api/v1/setup/github/callback`);
    expect(manifest.callback_urls).toEqual([`${BOARD_ORIGIN}/api/v1/auth/github/callback`]);
    expect(manifest.setup_url).toBe(`${BOARD_ORIGIN}/?github=installed`);
    expect(manifest.request_oauth_on_install).toBe(false);
    expect(String(manifest.name)).toMatch(/^Atlas-[0-9a-f]{6}$/);
    const set = response.cookies.find((entry) => entry.name === STATE_COOKIE);
    expect(set).toMatchObject({ httpOnly: true, sameSite: 'Lax', maxAge: 3600 });
    expect(set?.secure).toBeFalsy();
    expect(set?.path).toBe('/api/v1/setup/github');
    expect(cookie).not.toBe(state);
    expect(response.headers['cache-control']).toBe('no-store');

    const organization = await start(api.app, {}, { organization: 'acme-corp' });
    expect(organization.response.json<{ action: string }>().action).toMatch(
      new RegExp(`^${github.webUrl}/organizations/acme-corp/settings/apps/new\\?state=`),
    );
  });

  it('builds exactly the App settings of the design', () => {
    expect(buildManifest('http://localhost:5173', 'Atlas-abc123')).toEqual({
      name: 'Atlas-abc123',
      url: 'http://localhost:5173',
      redirect_url: 'http://localhost:5173/api/v1/setup/github/callback',
      callback_urls: ['http://localhost:5173/api/v1/auth/github/callback'],
      setup_url: 'http://localhost:5173/?github=installed',
      public: false,
      default_permissions: RIGHTS,
      request_oauth_on_install: false,
    });
  });

  it('refuses a bad organization name', async () => {
    const { response } = await start(api.app, {}, { organization: 'a/b' });
    expect(response.statusCode).toBe(400);
  });

  it('creates the App, writes the file with mode 0600 and gives a setup mark', async () => {
    const { state, cookie } = await start(api.app);
    github.state.manifestCodes.push('manifest-code-1');
    const response = await callback(
      api.app,
      { code: 'manifest-code-1', state },
      { [STATE_COOKIE]: cookie },
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`${BOARD_ORIGIN}/?setup=created`);
    expect(statSync(api.appFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(api.appFile, 'utf8'))).toEqual(github.secrets);
    const mark = response.cookies.find((entry) => entry.name === MARK_COOKIE);
    expect(mark).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/v1/auth' });
    expect(mark?.secure).toBeFalsy();
    expect(mark?.value.length).toBeGreaterThanOrEqual(43);
    const cleared = response.cookies.find((entry) => entry.name === STATE_COOKIE);
    expect(cleared?.value).toBe('');
    // Only the mark's hash is stored.
    const rows = installationRows(api);
    expect(rows).toEqual([{ key: 'setup_mark', value: sha256(mark?.value ?? '') }]);

    const auth = await api.app.inject('/api/v1/auth/state');
    expect(AuthStateResponseSchema.parse(auth.json())).toEqual({
      auth: 'github',
      setup: 'needs_owner',
      user: null,
      app: {
        name: github.secrets.name,
        account: github.secrets.account,
        installUrl: `${github.webUrl}/apps/${github.secrets.slug}/installations/new`,
      },
    });

    // The conversion went to GitHub once and the App was checked with its new key.
    const paths = github.state.requests.map((request) => `${request.method} ${request.path}`);
    expect(paths).toEqual([
      'POST /api/app-manifests/manifest-code-1/conversions',
      'GET /api/app',
      `GET /api/apps/${github.secrets.slug}`,
    ]);

    // Replaying the callback after success is refused and changes nothing.
    github.state.manifestCodes.push('manifest-code-1');
    const replay = await callback(
      api.app,
      { code: 'manifest-code-1', state },
      { [STATE_COOKIE]: cookie },
    );
    expect(replay.headers.location).toBe(failedTo('state_invalid'));
    expect(replay.cookies.find((entry) => entry.name === MARK_COOKIE)).toBeUndefined();

    // A new setup is refused while the App file exists.
    const again = await start(api.app);
    expect(again.response.statusCode).toBe(409);

    const log = logLines.join('');
    expect(log).toContain('/api/v1/setup/github/callback');
    for (const secret of [
      state,
      cookie,
      'manifest-code-1',
      github.secrets.clientSecret,
      github.secrets.privateKey.split('\n')[1] ?? 'missing',
      mark?.value ?? 'missing',
    ]) {
      expect(log).not.toContain(secret);
    }
  });

  it('refuses a callback without the browser cookie', async () => {
    const { state } = await start(api.app);
    github.state.manifestCodes.push('code-a');
    const response = await callback(api.app, { code: 'code-a', state });
    expect(response.headers.location).toBe(failedTo('state_invalid'));
    expectNothingWritten(response);
    // The manifest code was never sent to GitHub.
    expect(github.state.requests).toEqual([]);
  });

  it('refuses a callback whose cookie belongs to another start', async () => {
    const first = await start(api.app);
    const second = await start(api.app);
    github.state.manifestCodes.push('code-a');
    const response = await callback(
      api.app,
      { code: 'code-a', state: first.state },
      { [STATE_COOKIE]: second.cookie },
    );
    expect(response.headers.location).toBe(failedTo('state_invalid'));
    expectNothingWritten(response);
  });

  it('refuses a state that was never issued', async () => {
    const { cookie } = await start(api.app);
    github.state.manifestCodes.push('code-a');
    const response = await callback(
      api.app,
      { code: 'code-a', state: 'never-issued' },
      { [STATE_COOKIE]: cookie },
    );
    expect(response.headers.location).toBe(failedTo('state_invalid'));
    expectNothingWritten(response);
    // A refused callback clears the browser's state cookie too.
    const cleared = response.cookies.find((entry) => entry.name === STATE_COOKIE);
    expect(cleared).toMatchObject({ value: '', path: '/api/v1/setup/github' });
  });

  it('refuses a callback without a state', async () => {
    const { cookie } = await start(api.app);
    const response = await callback(api.app, { code: 'code-a' }, { [STATE_COOKIE]: cookie });
    expect(response.headers.location).toBe(failedTo('state_invalid'));
    expectNothingWritten(response);
  });

  it('refuses a state that was already used', async () => {
    const { state, cookie } = await start(api.app);
    // The first use fails at GitHub: the code is unknown there.
    const first = await callback(
      api.app,
      { code: 'unknown-code', state },
      { [STATE_COOKIE]: cookie },
    );
    expect(first.headers.location).toBe(failedTo('github_failed'));
    github.state.manifestCodes.push('code-a');
    const second = await callback(api.app, { code: 'code-a', state }, { [STATE_COOKIE]: cookie });
    expect(second.headers.location).toBe(failedTo('state_invalid'));
    expectNothingWritten(second);
  });

  it('refuses a state one hour and one second after start', async () => {
    const { state, cookie } = await start(api.app);
    time += HOUR + 1000;
    github.state.manifestCodes.push('code-a');
    const response = await callback(api.app, { code: 'code-a', state }, { [STATE_COOKIE]: cookie });
    expect(response.headers.location).toBe(failedTo('state_invalid'));
    expectNothingWritten(response);
  });

  it('accepts a state just under one hour old', async () => {
    const { state, cookie } = await start(api.app);
    time += HOUR - 1000;
    github.state.manifestCodes.push('code-a');
    const response = await callback(api.app, { code: 'code-a', state }, { [STATE_COOKIE]: cookie });
    expect(response.headers.location).toBe(`${BOARD_ORIGIN}/?setup=created`);
  });

  it('reports a cancel on GitHub', async () => {
    const { state, cookie } = await start(api.app);
    const response = await callback(
      api.app,
      { error: 'access_denied', state },
      { [STATE_COOKIE]: cookie },
    );
    expect(response.headers.location).toBe(failedTo('cancelled'));
    expectNothingWritten(response);
  });

  it('refuses a public App', async () => {
    const { state, cookie } = await start(api.app);
    github.state.appPublic = true;
    github.state.manifestCodes.push('code-a');
    const response = await callback(api.app, { code: 'code-a', state }, { [STATE_COOKIE]: cookie });
    expect(response.headers.location).toBe(failedTo('app_public'));
    expectNothingWritten(response);
  });

  it('refuses an App with other rights or with events', async () => {
    const variants: [Record<string, string>, string[]][] = [
      [{ contents: 'read', pull_requests: 'write', metadata: 'read' }, []],
      [{ contents: 'write', metadata: 'read' }, []],
      [{ ...RIGHTS, workflows: 'write' }, []],
      [{ ...RIGHTS, members: 'read' }, []],
      [{ ...RIGHTS }, ['push']],
    ];
    for (const [index, [permissions, events]] of variants.entries()) {
      const { state, cookie } = await start(api.app);
      github.state.appPermissions = permissions;
      github.state.appEvents = events;
      github.state.manifestCodes.push(`code-${index}`);
      const response = await callback(
        api.app,
        { code: `code-${index}`, state },
        { [STATE_COOKIE]: cookie },
      );
      expect(response.headers.location, JSON.stringify(permissions)).toBe(failedTo('app_rights'));
      expectNothingWritten(response);
    }
  });

  it('reports GitHub failing during conversion or verification', async () => {
    const failures: ((path: string) => boolean)[] = [
      (path) => path.includes('/conversions'),
      (path) => path === '/api/app',
      (path) => path.startsWith('/api/apps/'),
    ];
    for (const [index, fails] of failures.entries()) {
      const { state, cookie } = await start(api.app);
      github.state.failWhen = (request) => (fails(request.path) ? 500 : null);
      github.state.manifestCodes.push(`code-${index}`);
      const response = await callback(
        api.app,
        { code: `code-${index}`, state },
        { [STATE_COOKIE]: cookie },
      );
      expect(response.headers.location).toBe(failedTo('github_failed'));
      expectNothingWritten(response);
    }
  });

  it('lets only one of two racing callbacks write the App file', async () => {
    const first = await start(api.app);
    const second = await start(api.app);
    github.state.manifestCodes.push('code-a', 'code-b');
    const responses = await Promise.all([
      callback(api.app, { code: 'code-a', state: first.state }, { [STATE_COOKIE]: first.cookie }),
      callback(api.app, { code: 'code-b', state: second.state }, { [STATE_COOKIE]: second.cookie }),
    ]);
    const locations = responses.map((response) => response.headers.location).sort();
    expect(locations).toEqual([`${BOARD_ORIGIN}/?setup=created`, failedTo('state_invalid')].sort());
    const marks = responses.filter((response) =>
      response.cookies.some((entry) => entry.name === MARK_COOKIE),
    );
    expect(marks).toHaveLength(1);
    expect(existsSync(api.appFile)).toBe(true);
  });

  it('keeps setup endpoints open while no owner exists', async () => {
    expect((await start(api.app)).response.statusCode).toBe(200);
    const code = await api.app.inject({
      method: 'POST',
      url: OWNER_CODE,
      payload: { code: 'guess' },
    });
    expect(code.statusCode).toBe(403);
    expect(code.json()).toMatchObject({ error: { code: 'owner_code_invalid' } });
  });

  it('does not create an owner code without an App file', () => {
    expect(api.ownerCodes).toEqual([]);
  });
});

describe('setup once an owner exists', () => {
  let sessions: { owner: string; member: string };
  beforeEach(async () => {
    resetStandIn();
    api = await build();
    sessions = addUsers(api);
  });
  afterEach(async () => {
    await api.close();
  });

  it('answers 401 without a session and 403 with a member session', async () => {
    const requests = [
      { method: 'POST' as const, url: START, payload: {} },
      { method: 'GET' as const, url: `${CALLBACK}?code=x&state=y` },
      { method: 'POST' as const, url: OWNER_CODE, payload: { code: 'x' } },
    ];
    for (const request of requests) {
      const anonymous = await api.app.inject(request);
      expect(anonymous.statusCode, request.url).toBe(401);
      const member = await api.app.inject({
        ...request,
        cookies: { atlas_session: sessions.member },
      });
      expect(member.statusCode, request.url).toBe(403);
      expect(member.json()).toMatchObject({ error: { code: 'owner_required' } });
    }
    const owner = await start(api.app, { atlas_session: sessions.owner });
    expect(owner.response.statusCode).toBe(200);
  });

  it('lets the owner run setup again', async () => {
    const { state, cookie } = await start(api.app, { atlas_session: sessions.owner });
    github.state.manifestCodes.push('code-a');
    const response = await callback(
      api.app,
      { code: 'code-a', state },
      { [STATE_COOKIE]: cookie, atlas_session: sessions.owner },
    );
    expect(response.headers.location).toBe(`${BOARD_ORIGIN}/?setup=created`);
    expect(existsSync(api.appFile)).toBe(true);
    // The owner is signed in already: no setup mark is given or stored.
    expect(response.cookies.find((entry) => entry.name === MARK_COOKIE)).toBeUndefined();
    expect(installationRows(api)).toEqual([]);
  });
});

describe('setup when the App file cannot be written', () => {
  let base: string;
  let appFile: string;
  beforeEach(async () => {
    resetStandIn();
    // The App file's folder is a link to nothing: reading finds no file, writing fails.
    base = await mkdtemp(join(tmpdir(), 'atlas-setup-write-'));
    symlinkSync(join(base, 'missing'), join(base, 'gone'));
    appFile = join(base, 'gone', 'github-app.json');
    time = Date.parse('2026-11-25T10:00:00.000Z');
    logLines = [];
    api = await buildAuthApp({
      now: () => new Date(time),
      logStream: { write: (line: string) => void logLines.push(line) },
      auth: {
        appFile,
        githubApiUrl: github.apiUrl,
        githubWebUrl: github.webUrl,
        ownerCodeSink: () => undefined,
      },
    });
  });
  afterEach(async () => {
    await api.close();
    await rm(base, { recursive: true, force: true });
  });

  it('redirects with github_failed, clears the state cookie and writes nothing', async () => {
    const { state, cookie } = await start(api.app);
    github.state.manifestCodes.push('code-a');
    const response = await callback(api.app, { code: 'code-a', state }, { [STATE_COOKIE]: cookie });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(failedTo('github_failed'));
    const cleared = response.cookies.find((entry) => entry.name === STATE_COOKIE);
    expect(cleared).toMatchObject({ value: '', path: '/api/v1/setup/github' });
    expect(response.cookies.find((entry) => entry.name === MARK_COOKIE)).toBeUndefined();
    expect(existsSync(appFile)).toBe(false);
    expect(readdirSync(base)).toEqual(['gone']);
    expect(installationRows(api)).toEqual([]);

    const log = logLines.join('');
    expect(log).toContain('GitHub App setup failed with an unexpected error');
    for (const secret of [
      state,
      cookie,
      'code-a',
      github.secrets.clientSecret,
      github.secrets.privateKey.split('\n')[1] ?? 'missing',
      appFile,
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe('the owner code', () => {
  beforeEach(async () => {
    resetStandIn();
    api = await build({
      prepare: ({ appFile }) =>
        writeFileSync(appFile, JSON.stringify(github.secrets), { mode: 0o600 }),
    });
  });
  afterEach(async () => {
    await api.close();
  });

  it('is created once at start and trades once for a setup mark', async () => {
    expect(api.ownerCodes).toHaveLength(1);
    const code = api.ownerCodes[0] ?? '';
    expect(code.length).toBeGreaterThanOrEqual(43);
    expect(installationRows(api)).toEqual([{ key: 'owner_code', value: sha256(code) }]);

    const wrong = await api.app.inject({
      method: 'POST',
      url: OWNER_CODE,
      payload: { code: `${code.slice(0, -1)}x` },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.cookies).toEqual([]);

    const traded = await api.app.inject({ method: 'POST', url: OWNER_CODE, payload: { code } });
    expect(traded.statusCode).toBe(204);
    const mark = traded.cookies.find((entry) => entry.name === MARK_COOKIE);
    expect(mark).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/v1/auth' });
    expect(installationRows(api)).toEqual([
      { key: 'setup_mark', value: sha256(mark?.value ?? '') },
    ]);

    const reused = await api.app.inject({ method: 'POST', url: OWNER_CODE, payload: { code } });
    expect(reused.statusCode).toBe(403);
    expect(reused.json()).toMatchObject({ error: { code: 'owner_code_invalid' } });

    const log = logLines.join('');
    expect(log).toContain('/api/v1/setup/owner-code');
    expect(log).not.toContain(code);
    expect(log).not.toContain(mark?.value ?? 'missing');
  });

  it('fills the App in the sign-in state only before an owner exists or when signed in', async () => {
    const app = {
      name: github.secrets.name,
      account: github.secrets.account,
      installUrl: `${github.webUrl}/apps/${github.secrets.slug}/installations/new`,
    };
    expect((await api.app.inject('/api/v1/auth/state')).json()).toMatchObject({
      setup: 'needs_owner',
      app,
    });
    const sessions = addUsers(api);
    expect((await api.app.inject('/api/v1/auth/state')).json()).toMatchObject({
      setup: 'done',
      app: null,
    });
    const signedIn = await api.app.inject({
      url: '/api/v1/auth/state',
      cookies: { atlas_session: sessions.member },
    });
    expect(signedIn.json()).toMatchObject({ setup: 'done', app });
  });
});

describe('startup checks', () => {
  afterEach(() => resetStandIn());

  it('creates no owner code when an owner exists', { timeout: 30_000 }, async () => {
    const target = await build({
      prepare: ({ appFile, dbPath }) => {
        writeFileSync(appFile, JSON.stringify(github.secrets), { mode: 0o600 });
        const database = openDatabase(dbPath, () => new Date().toISOString());
        try {
          database.db
            .insert(users)
            .values({
              id: 'u-owner',
              githubId: 1,
              login: 'octo',
              name: null,
              avatarUrl: null,
              role: 'owner',
              createdAt: '2026-11-25T00:00:00.000Z',
            })
            .run();
        } finally {
          database.close();
        }
      },
    });
    try {
      expect(target.ownerCodes).toEqual([]);
      expect(installationRows(target)).toEqual([]);
    } finally {
      await target.close();
    }
  });

  it('refuses to start with an App file that does not parse', { timeout: 30_000 }, async () => {
    let path = '';
    await expect(
      build({
        prepare: ({ appFile }) => {
          path = appFile;
          writeFileSync(appFile, '{"appId": 1', { mode: 0o600 });
        },
      }),
    ).rejects.toThrow(/GitHub App file is not readable: .*github-app\.json/);
    expect(path).not.toBe('');
  });

  it(
    'refuses to start when the App file lies under a Worker workspace root',
    { timeout: 30_000 },
    async () => {
      await expect(
        build({
          prepare: ({ directory, dbPath }) => {
            const database = openDatabase(dbPath, () => new Date().toISOString());
            try {
              database.db
                .insert(workers)
                .values({
                  id: 'atlas:test',
                  name: 'Test',
                  kind: 'atlas',
                  availability: 'offline',
                  lastSeenAt: null,
                  workspaceRoot: directory,
                  capabilities: ['repository.init'],
                })
                .run();
            } finally {
              database.close();
            }
          },
        }),
      ).rejects.toThrow(/workspace root/);
    },
  );

  it('marks the state cookie Secure on an https Board origin', { timeout: 30_000 }, async () => {
    const target = await build({}, 'https://localhost:5173');
    try {
      const response = await target.app.inject({
        method: 'POST',
        url: START,
        payload: {},
        headers: { origin: 'https://localhost:5173' },
      });
      expect(response.statusCode).toBe(200);
      const set = response.cookies.find((entry) => entry.name === STATE_COOKIE);
      expect(set?.secure).toBe(true);
    } finally {
      await target.close();
    }
  });
});

describe('the GitHub connection', () => {
  let sessions: { owner: string; member: string };
  beforeEach(async () => {
    resetStandIn();
    api = await build({
      prepare: ({ appFile }) =>
        writeFileSync(appFile, JSON.stringify(github.secrets), { mode: 0o600 }),
    });
    sessions = addUsers(api);
  });
  afterEach(async () => {
    await api.close();
  });

  it('names the App, its account and where to manage and install it', async () => {
    const response = await api.app.inject({
      url: '/api/v1/github/connection',
      cookies: { atlas_session: sessions.member },
    });
    expect(response.statusCode).toBe(200);
    expect(GithubConnectionResponseSchema.parse(response.json())).toEqual({
      connection: {
        name: github.secrets.name,
        slug: github.secrets.slug,
        account: github.secrets.account,
        manageUrl: `${github.webUrl}/organizations/${github.secrets.account}/settings/apps/${github.secrets.slug}`,
        installUrl: `${github.webUrl}/apps/${github.secrets.slug}/installations/new`,
      },
    });
    github.state.appOwnerType = 'User';
    const personal = await api.app.inject({
      url: '/api/v1/github/connection',
      cookies: { atlas_session: sessions.member },
    });
    expect(personal.json()).toMatchObject({
      connection: { manageUrl: `${github.webUrl}/settings/apps/${github.secrets.slug}` },
    });
  });

  it('requires a session', async () => {
    const response = await api.app.inject('/api/v1/github/connection');
    expect(response.statusCode).toBe(401);
  });

  it('answers a clear error when GitHub fails', async () => {
    github.state.failWith = 500;
    const response = await api.app.inject({
      url: '/api/v1/github/connection',
      cookies: { atlas_session: sessions.owner },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { code: 'github_unavailable', message: 'GitHub could not read the App: failed (500)' },
    });
  });
});

describe('the GitHub connection with GitHub unreachable', () => {
  beforeEach(async () => {
    resetStandIn();
    api = await buildAuthApp(
      {},
      {
        github: { apiUrl: 'http://127.0.0.1:1/api', webUrl: 'http://127.0.0.1:1' },
        prepare: ({ appFile }) =>
          writeFileSync(appFile, JSON.stringify(github.secrets), { mode: 0o600 }),
      },
    );
    time = Date.now();
  });
  afterEach(async () => {
    await api.close();
  });

  it('answers 502 without internals', async () => {
    const sessions = addUsers(api);
    const response = await api.app.inject({
      url: '/api/v1/github/connection',
      cookies: { atlas_session: sessions.owner },
    });
    expect(response.statusCode).toBe(502);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error).toEqual({
      code: 'github_unavailable',
      message: 'GitHub could not read the App: unreachable',
    });
  });

  it('answers 502 when the App key is not accepted', async () => {
    await api.close();
    api = await buildAuthApp(
      {},
      {
        github: { apiUrl: github.apiUrl, webUrl: github.webUrl },
        prepare: ({ appFile }) =>
          writeFileSync(appFile, JSON.stringify(TEST_APP_SECRETS), { mode: 0o600 }),
      },
    );
    const sessions = addUsers(api);
    const response = await api.app.inject({
      url: '/api/v1/github/connection',
      cookies: { atlas_session: sessions.owner },
    });
    expect(response.statusCode).toBe(502);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('github_unavailable');
    expect(body.error.message).not.toMatch(/BEGIN|secret|127\.0\.0\.1/);
  }, 30_000);
});
