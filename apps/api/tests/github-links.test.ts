import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GithubLinkResponseSchema,
  GithubRepositoryListResponseSchema,
  ProjectResponseSchema,
} from '@atlas/contracts';
import SQLite from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { BOARD_ORIGIN, buildAuthApp, signIn } from './support/auth-app.js';
import { startGithubStandIn } from './support/github-stand-in.js';
import type { GithubStandIn } from './support/github-stand-in.js';

const OWNER = { id: 101, login: 'the-owner' };
const REPOSITORY = {
  id: 501,
  fullName: 'octo-org/atlas',
  private: true,
  defaultBranch: 'main',
  installationId: 1,
};

type Api = Awaited<ReturnType<typeof buildAuthApp>>;

let github: GithubStandIn;
let api: Api;
let owner: string;

beforeAll(async () => {
  github = await startGithubStandIn();
});
afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  Object.assign(github.state, {
    users: {},
    authorizeCode: null,
    failWith: null,
    failWhen: undefined,
    requests: [],
    installations: [{ id: 1, account: github.secrets.account }],
    repositories: [{ ...REPOSITORY }],
  });
  api = await buildAuthApp(
    {},
    {
      github,
      prepare: ({ appFile }) =>
        writeFileSync(appFile, JSON.stringify(github.secrets), { mode: 0o600 }),
    },
  );
  const traded = await api.app.inject({
    method: 'POST',
    url: '/api/v1/setup/owner-code',
    payload: { code: api.ownerCodes[0] ?? '' },
  });
  const mark = traded.cookies.find((entry) => entry.name === 'atlas_setup_mark')?.value ?? '';
  owner = await signIn(api.app, OWNER, { atlas_setup_mark: mark });
}, 30_000);
afterEach(async () => {
  await api.close();
});

// Inserts a project the way Worker provisioning leaves it, without a Worker.
function seedProject(repository: object, state: string) {
  const id = randomUUID();
  const db = new SQLite(join(api.directory, 'atlas.sqlite'));
  try {
    const now = '2026-11-25T10:00:00.000Z';
    db.prepare(
      'insert into projects (id, name, repository, state, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?)',
    ).run(id, 'Project', JSON.stringify(repository), state, now, now);
  } finally {
    db.close();
  }
  return id;
}

const local = { mode: 'local', workerId: 'atlas:test', relativePath: 'repo', localPath: '/w/repo' };

function readyProject() {
  return seedProject(local, 'ready');
}

function linkUrl(projectId: string) {
  return `/api/v1/projects/${projectId}/github-link`;
}

function link(projectId: string, repositoryId: number) {
  return api.app.inject({
    method: 'POST',
    url: linkUrl(projectId),
    headers: { cookie: owner },
    payload: { repositoryId },
  });
}

function getLink(projectId: string) {
  return api.app.inject({ url: linkUrl(projectId), headers: { cookie: owner } });
}

function unlink(projectId: string) {
  return api.app.inject({
    method: 'DELETE',
    url: linkUrl(projectId),
    headers: { cookie: owner },
    payload: {},
  });
}

function errorCode(response: { json(): unknown }) {
  return (response.json() as { error: { code: string } }).error.code;
}

describe('repositories and links', { timeout: 30_000 }, () => {
  it('lists the repositories the App can access', async () => {
    const response = await api.app.inject({
      url: '/api/v1/github/repositories',
      headers: { cookie: owner },
    });
    expect(response.statusCode).toBe(200);
    expect(GithubRepositoryListResponseSchema.parse(response.json()).items).toEqual([
      { id: 501, fullName: 'octo-org/atlas', private: true, defaultBranch: 'main' },
    ]);
  });

  it('answers 502 when GitHub cannot list repositories', async () => {
    github.state.failWith = 500;
    const response = await api.app.inject({
      url: '/api/v1/github/repositories',
      headers: { cookie: owner },
    });
    expect(response.statusCode).toBe(502);
    expect(errorCode(response)).toBe('github_unavailable');
  });

  it('links a ready local project and stores the repository details', async () => {
    const projectId = readyProject();
    const response = await link(projectId, 501);
    expect(response.statusCode).toBe(201);
    expect(GithubLinkResponseSchema.parse(response.json()).link).toMatchObject({
      projectId,
      repositoryId: 501,
      fullName: 'octo-org/atlas',
      defaultBranch: 'main',
      accessible: true,
    });
    const fetched = await getLink(projectId);
    expect(fetched.statusCode).toBe(200);
    expect(GithubLinkResponseSchema.parse(fetched.json()).link?.repositoryId).toBe(501);
  });

  it('shows no link for a project without one', async () => {
    const response = await getLink(readyProject());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ link: null });
  });

  it('refuses an unknown project', async () => {
    expect((await link(randomUUID(), 501)).statusCode).toBe(404);
    expect((await getLink(randomUUID())).statusCode).toBe(404);
    expect((await unlink(randomUUID())).statusCode).toBe(404);
  });

  it('refuses an existing project', async () => {
    const projectId = seedProject(
      { mode: 'existing', gitUrl: 'https://example.com/r.git' },
      'ready',
    );
    const response = await link(projectId, 501);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('project_not_linkable');
  });

  it('refuses a project that is not ready', async () => {
    const response = await link(seedProject({ ...local, localPath: null }, 'pending'), 501);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('project_not_linkable');
  });

  it('refuses a second link', async () => {
    const projectId = readyProject();
    expect((await link(projectId, 501)).statusCode).toBe(201);
    const again = await link(projectId, 501);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('already_linked');
  });

  it('refuses a repository the App does not cover', async () => {
    const response = await link(readyProject(), 999);
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('repository_not_accessible');
  });

  it('refuses a repository of a suspended installation', async () => {
    github.state.installations = [{ id: 1, account: 'octo-org', suspended: true }];
    const response = await link(readyProject(), 501);
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('repository_not_accessible');
  });

  it('shows accessible: false after the App loses the repository', async () => {
    const projectId = readyProject();
    await link(projectId, 501);
    github.state.repositories = [];
    const shown = GithubLinkResponseSchema.parse((await getLink(projectId)).json()).link;
    expect(shown).toMatchObject({ fullName: 'octo-org/atlas', accessible: false });
  });

  it('shows accessible: false when the installation is suspended', async () => {
    const projectId = readyProject();
    await link(projectId, 501);
    github.state.installations = [{ id: 1, account: 'octo-org', suspended: true }];
    const response = await getLink(projectId);
    expect(response.statusCode).toBe(200);
    expect(GithubLinkResponseSchema.parse(response.json()).link?.accessible).toBe(false);
  });

  it('shows accessible: false when GitHub cannot be reached', async () => {
    const projectId = readyProject();
    await link(projectId, 501);
    github.state.failWith = 500;
    const response = await getLink(projectId);
    expect(response.statusCode).toBe(200);
    expect(GithubLinkResponseSchema.parse(response.json()).link).toMatchObject({
      fullName: 'octo-org/atlas',
      accessible: false,
    });
  });

  it('keeps the stored name and stays accessible after a rename', async () => {
    const projectId = readyProject();
    await link(projectId, 501);
    github.state.repositories = [{ ...REPOSITORY, fullName: 'octo-org/renamed' }];
    const shown = GithubLinkResponseSchema.parse((await getLink(projectId)).json()).link;
    expect(shown).toMatchObject({ fullName: 'octo-org/atlas', accessible: true });
  });

  it('removes a link once', async () => {
    const projectId = readyProject();
    await link(projectId, 501);
    expect((await unlink(projectId)).statusCode).toBe(204);
    expect((await getLink(projectId)).json()).toEqual({ link: null });
    const second = await unlink(projectId);
    expect(second.statusCode).toBe(404);
    expect(errorCode(second)).toBe('link_not_found');
  });

  it('requires a session', async () => {
    const response = await api.app.inject({ url: linkUrl(readyProject()) });
    expect(response.statusCode).toBe(401);
  });

  it('keeps the project JSON free of link data', async () => {
    const projectId = readyProject();
    await link(projectId, 501);
    const response = await api.app.inject({
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie: owner },
    });
    const { project } = ProjectResponseSchema.parse(response.json());
    expect(Object.keys(project).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'operationId',
      'repository',
      'state',
      'updatedAt',
    ]);
  });
});

describe('with sign-in off', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    app = await buildApp({
      dbPath: ':memory:',
      workerToken: 'test-token',
      allowedOrigin: BOARD_ORIGIN,
    });
  });
  afterEach(async () => {
    await app.close();
  });

  it('answers 409 github_unavailable on every GitHub route', async () => {
    const url = `/api/v1/projects/${randomUUID()}/github-link`;
    const responses = await Promise.all([
      app.inject({ url: '/api/v1/github/repositories' }),
      app.inject({ url }),
      app.inject({ method: 'POST', url, payload: { repositoryId: 1 } }),
      app.inject({ method: 'DELETE', url, payload: {} }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('github_unavailable');
    }
  });
});
