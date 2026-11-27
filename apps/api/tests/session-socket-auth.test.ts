import { writeFileSync } from 'node:fs';
import {
  ProjectCreateResponseSchema,
  TaskResponseSchema,
  VersionListResponseSchema,
} from '@atlas/contracts';
import SQLite from 'better-sqlite3';
import type WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOARD_ORIGIN, buildAuthApp, signIn } from './support/auth-app.js';
import { startGithubStandIn } from './support/github-stand-in.js';
import type { GithubStandIn } from './support/github-stand-in.js';

const OWNER = { id: 101, login: 'the-owner' };
const MEMBER = { id: 7, login: 'octo-cat' };
const RECHECK_MS = 50;

type Api = Awaited<ReturnType<typeof buildAuthApp>>;

let github: GithubStandIn;
let api: Api;
let owner: string;
let member: string;
let memberId: string;
let taskId: string;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  github = await startGithubStandIn();
});
afterAll(async () => {
  await github.close();
});

// Builds the API with an owner, a signed-in member and a task the member created.
async function prepare(recheckMs: number) {
  Object.assign(github.state, { users: {}, authorizeCode: null, failWith: null, requests: [] });
  api = await buildAuthApp(
    { sessionRecheckMs: recheckMs },
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
  const added = await api.app.inject({
    method: 'POST',
    url: '/api/v1/members',
    headers: { cookie: owner },
    payload: { login: MEMBER.login },
  });
  memberId = added.json<{ member: { id: string } }>().member.id;
  member = await signIn(api.app, MEMBER);

  const created = await api.app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie: member },
    payload: {
      name: 'Remote',
      repository: { mode: 'existing', gitUrl: 'https://example.com/acme/repo.git' },
    },
  });
  expect(created.body).not.toContain('createdBy');
  const projectId = ProjectCreateResponseSchema.parse(created.json()).project.id;
  const versions = VersionListResponseSchema.parse(
    (
      await api.app.inject({
        url: `/api/v1/projects/${projectId}/versions`,
        headers: { cookie: member },
      })
    ).json(),
  );
  const task = await api.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/versions/${versions.items[0]?.id}/tasks`,
    headers: { cookie: member },
    payload: { title: 'Fix the login bug', description: 'It fails.' },
  });
  expect(task.body).not.toContain('createdBy');
  taskId = TaskResponseSchema.parse(task.json()).task.id;
}

function database() {
  return new SQLite(`${api.directory}/atlas.sqlite`);
}

async function open(cookie: string) {
  const socket = await api.app.injectWS(`/api/v1/tasks/${taskId}/session`, {
    headers: { host: 'localhost', origin: BOARD_ORIGIN, cookie },
  });
  sockets.push(socket);
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  return { socket, closed };
}

function within<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Not settled within ${ms} ms`)), ms),
    ),
  ]);
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await api.close();
});

// A recheck this long never runs during a test, so a close proves the immediate path.
describe('with the default recheck interval', { timeout: 30_000 }, () => {
  beforeEach(() => prepare(30_000), 30_000);

  it('records who created the project and the task', () => {
    const sqlite = database();
    try {
      const projectRows = sqlite.prepare('SELECT createdBy FROM projects').all();
      const taskRows = sqlite.prepare('SELECT createdBy FROM tasks').all();
      expect(projectRows).toEqual([{ createdBy: memberId }]);
      expect(taskRows).toEqual([{ createdBy: memberId }]);
    } finally {
      sqlite.close();
    }
  });

  it('opens for a signed-in user and closes at once when the member is removed', async () => {
    const { socket, closed } = await open(member);
    const ownerSocket = await open(owner);
    expect(socket.readyState).toBe(socket.OPEN);
    const removed = await api.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${memberId}`,
      headers: { cookie: owner },
      payload: {},
    });
    expect(removed.statusCode).toBe(204);
    expect(await within(closed, 2000)).toBe(4401);
    expect(ownerSocket.socket.readyState).toBe(ownerSocket.socket.OPEN);
  });

  it('closes at once on sign-out and keeps the same user’s other session open', async () => {
    const other = await signIn(api.app, MEMBER);
    const { closed } = await open(member);
    const kept = await open(other);
    const response = await api.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { cookie: member, origin: BOARD_ORIGIN },
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    expect(await within(closed, 2000)).toBe(4401);
    expect(kept.socket.readyState).toBe(kept.socket.OPEN);
  });

  it('refuses the socket without a session', async () => {
    await expect(
      api.app.injectWS(`/api/v1/tasks/${taskId}/session`, {
        headers: { host: 'localhost', origin: BOARD_ORIGIN },
      }),
    ).rejects.toThrow('401');
  });
});

describe('with a shortened recheck interval', { timeout: 30_000 }, () => {
  beforeEach(() => prepare(RECHECK_MS), 30_000);

  it('closes within the recheck interval once its session is gone', async () => {
    const { socket, closed } = await open(member);
    const ownerSocket = await open(owner);
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 3));
    expect(socket.readyState).toBe(socket.OPEN);
    const sqlite = database();
    try {
      sqlite.prepare('DELETE FROM auth_sessions WHERE userId = ?').run(memberId);
    } finally {
      sqlite.close();
    }
    expect(await within(closed, RECHECK_MS * 20)).toBe(4401);
    expect(ownerSocket.socket.readyState).toBe(ownerSocket.socket.OPEN);
  });
});
