import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { ApiOptions } from '../../src/app.js';
import type { GithubStandIn } from './github-stand-in.js';

// The stand-in each app was built against, when `extras.github` was a started stand-in.
const standIns = new WeakMap<FastifyInstance, GithubStandIn>();

function isStandIn(github: { apiUrl: string; webUrl: string }): github is GithubStandIn {
  return 'state' in github && 'secrets' in github;
}

// Signs `user` in through the real routes and the stand-in GitHub, and returns the `Cookie`
// header value for the new session. Build the app with the started stand-in as `extras.github`
// and an App file holding its secrets. `cookies` are sent to both sign-in routes, for example the
// setup mark. Each call uses a fresh sign-in code: the stand-in accepts a code once.
export async function signIn(
  app: FastifyInstance,
  user: { id: number; login: string },
  cookies: Record<string, string> = {},
): Promise<string> {
  const github = standIns.get(app);
  if (!github) throw new Error('Build the app with a started GitHub stand-in to sign in');
  const code = `signin-${randomBytes(8).toString('hex')}`;
  github.state.users[code] = { id: user.id, login: user.login, name: null, avatarUrl: null };
  const previous = github.state.authorizeCode;
  github.state.authorizeCode = code;
  try {
    const start = await app.inject({ url: '/api/v1/auth/github/start', cookies });
    const signinCookie = start.cookies.find((entry) => entry.name === 'atlas_signin')?.value;
    const authorize = start.headers.location;
    if (typeof authorize !== 'string' || !signinCookie) {
      throw new Error(`Sign-in did not start: ${start.statusCode}`);
    }
    const page = await fetch(authorize, { redirect: 'manual' });
    const back = page.headers.get('location');
    if (!back) throw new Error(`The stand-in did not redirect back: ${page.status}`);
    const target = new URL(back);
    const callback = await app.inject({
      url: `${target.pathname}${target.search}`,
      cookies: { ...cookies, atlas_signin: signinCookie },
    });
    const session = callback.cookies.find((entry) => entry.name === 'atlas_session')?.value;
    if (!session) throw new Error(`Sign-in failed: ${String(callback.headers.location)}`);
    return `atlas_session=${session}`;
  } finally {
    github.state.authorizeCode = previous;
  }
}

export const BOARD_ORIGIN = 'http://localhost:5173';
export const WORKER_TOKEN = 'test-token';

// An App file in the shape the API stores after setup; written by hand until Task 4.
export const TEST_APP_SECRETS = {
  appId: 1,
  slug: 'atlas-test',
  name: 'Atlas test',
  account: 'octo',
  clientId: 'Iv1.test',
  clientSecret: 'secret',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n',
};

export type AuthAppExtras = {
  // Points the API at a GitHub stand-in.
  github?: { apiUrl: string; webUrl: string };
  // Runs before the API is built, for example to write the App file or seed the database.
  prepare?: (paths: { directory: string; appFile: string; dbPath: string }) => unknown;
};

// Builds the API with sign-in on, a database and an App file path in a temporary directory.
// The App file is not created; tests that need setup done write it themselves.
export async function buildAuthApp(
  overrides: Partial<ApiOptions> = {},
  extras: AuthAppExtras = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-auth-'));
  const appFile = join(directory, 'github-app.json');
  const ownerCodes: string[] = [];
  let app: FastifyInstance;
  try {
    await extras.prepare?.({ directory, appFile, dbPath: join(directory, 'atlas.sqlite') });
    app = await buildApp({
      dbPath: join(directory, 'atlas.sqlite'),
      workerToken: WORKER_TOKEN,
      allowedOrigin: BOARD_ORIGIN,
      ...overrides,
      auth: {
        appFile,
        ownerCodeSink: (code) => ownerCodes.push(code),
        ...(extras.github
          ? { githubApiUrl: extras.github.apiUrl, githubWebUrl: extras.github.webUrl }
          : {}),
        ...overrides.auth,
      },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  if (extras.github && isStandIn(extras.github)) standIns.set(app, extras.github);
  return {
    app,
    appFile,
    directory,
    ownerCodes,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
