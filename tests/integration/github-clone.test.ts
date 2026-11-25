import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD_ORIGIN, WORKER_TOKEN } from '../../apps/api/tests/support/auth-app.js';
import { REPOSITORY, resetStandIn, startCloneApi } from '../../apps/api/tests/support/clone-api.js';
import type { CloneApi } from '../../apps/api/tests/support/clone-api.js';
import { startGithubStandIn } from '../../apps/api/tests/support/github-stand-in.js';
import type { GithubStandIn } from '../../apps/api/tests/support/github-stand-in.js';
import { startWorker } from '../../apps/worker/src/main.js';
import {
  ApiToBoardSessionMessageSchema,
  OperationResponseSchema,
  ProjectCreateResponseSchema,
  ProjectResponseSchema,
  TaskResponseSchema,
  VersionListResponseSchema,
  WorkerListResponseSchema,
} from '../../packages/contracts/src/index.js';
import type { ApiToBoardSessionMessage } from '../../packages/contracts/src/index.js';
import { startGitHost } from './support/github-git-server.js';
import type { GitHost } from './support/github-git-server.js';

const execute = promisify(execFile);
const agent = fileURLToPath(new URL('../../apps/worker/tests/fixtures/agent.mjs', import.meta.url));

// Real processes on a slow filesystem: every wait here is generous, except the five seconds that
// the Worker may take to stop, which is a product requirement.
const WAIT = { timeout: 60_000, interval: 100 };
const TEST_TIMEOUT_MS = 180_000;
const STOP_LIMIT_MS = 5_000;
const WORKER_ID = 'atlas:github-clone';

const SLOW = {
  id: 502,
  fullName: 'octo-org/slow',
  private: true,
  defaultBranch: 'main',
  installationId: 1,
};

let github: GithubStandIn;
let host: GitHost;
let api: CloneApi;
let directory: string;
let address: string;
let worker: { stop(): Promise<void> } | undefined;
const sockets: { terminate(): void }[] = [];

const root = () => join(directory, 'repos');

function launchWorker() {
  return startWorker({
    apiUrl: `${address.replace('http:', 'ws:')}/api/v1/workers/connect`,
    token: WORKER_TOKEN,
    id: WORKER_ID,
    name: 'GitHub clone worker',
    root: root(),
    stateDir: join(directory, 'state'),
    gitHostUrl: host.url,
    agent: { command: [process.execPath, agent], sandbox: 'off', allowedDomains: [] },
  });
}

const getJson = async (url: string) =>
  (await api.app.inject({ url, headers: { cookie: api.owner } })).json<unknown>();

const online = async () =>
  WorkerListResponseSchema.parse(await getJson('/api/v1/workers')).items.filter(
    (item) => item.availability === 'online',
  ).length;

const project = async (projectId: string) =>
  ProjectResponseSchema.parse(await getJson(`/api/v1/projects/${projectId}`)).project;

async function create(relativePath: string, repositoryId: number) {
  const response = await api.create(
    { mode: 'local', workerId: WORKER_ID, relativePath, githubRepositoryId: repositoryId },
    relativePath,
  );
  expect(response.statusCode).toBe(202);
  return ProjectCreateResponseSchema.parse(response.json<unknown>());
}

// Records every frame a Board socket receives, from the moment it opens.
class Board {
  readonly messages: ApiToBoardSessionMessage[] = [];
  constructor(readonly socket: { send(data: string): void }) {}
  get output() {
    return this.messages.flatMap((m) => (m.type === 'output' ? [m.data] : [])).join('');
  }
  get session() {
    return this.messages.filter((m) => m.type === 'session').at(-1);
  }
}

async function openBoard(taskId: string) {
  let board!: Board;
  // Attached on init: the first frames arrive as soon as the socket opens.
  const socket = await api.app.injectWS(
    `/api/v1/tasks/${taskId}/session`,
    { headers: { host: 'localhost', origin: BOARD_ORIGIN, cookie: api.owner } },
    {
      onInit: (ws) => {
        board = new Board(ws);
        ws.on('message', (data: Buffer) => {
          board.messages.push(
            ApiToBoardSessionMessageSchema.parse(JSON.parse(data.toString('utf8'))),
          );
        });
      },
    },
  );
  sockets.push(socket);
  return board;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atlas-github-clone-'));
  github = await startGithubStandIn();
  resetStandIn(github);
  github.state.repositories.push({ ...SLOW });
  host = await startGitHost(github);
  await host.addRepository(REPOSITORY.fullName, {
    'README.md': '# Atlas clone\n',
    'src/nested/file.txt': 'nested content\n',
  });
  await host.addRepository(SLOW.fullName, { 'README.md': 'slow\n' });
  host.stall(SLOW.fullName);
  api = await startCloneApi(github);
  address = await api.app.listen({ host: '127.0.0.1', port: 0 });
  worker = launchWorker();
}, 60_000);

afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await worker?.stop();
  await api?.close();
  await host?.close();
  await github?.close();
  await rm(directory, { recursive: true, force: true });
}, 60_000);

describe('cloning from GitHub through a real API and a real Worker', () => {
  it(
    'clones with a token scoped to one repository and starts a session on the clone',
    async () => {
      // Sign-in is on: the Board's routes need a session, and the Worker still connects with its token.
      expect((await fetch(`${address}/api/v1/workers`)).status).toBe(401);
      await expect.poll(online, WAIT).toBe(1);

      const created = await create('cloned', REPOSITORY.id);
      const operationId = created.operation?.id ?? '';
      expect(created.project.state).toBe('pending');
      await expect.poll(async () => (await project(created.project.id)).state, WAIT).toBe('ready');
      const operation = OperationResponseSchema.parse(
        await getJson(`/api/v1/operations/${operationId}`),
      ).operation;
      expect(operation.state).toBe('succeeded');

      // The files of the repository are in the workspace, with its history and default branch.
      const target = join(root(), 'cloned');
      expect(await readFile(join(target, 'README.md'), 'utf8')).toBe('# Atlas clone\n');
      expect(await readFile(join(target, 'src/nested/file.txt'), 'utf8')).toBe('nested content\n');
      const git = (...args: string[]) =>
        execute('git', ['-c', 'safe.directory=*', '-C', target, ...args]).then(({ stdout }) =>
          stdout.trim(),
        );
      expect(await git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(await git('log', '-1', '--format=%s')).toBe('Initial commit');
      expect(await git('status', '--porcelain')).toBe('');
      expect(await git('remote', 'get-url', 'origin')).toBe(`${host.url}/${REPOSITORY.fullName}`);
      expect(
        VersionListResponseSchema.parse(
          await getJson(`/api/v1/projects/${created.project.id}/versions`),
        ).items,
      ).toHaveLength(1);

      // The Git host asked for credentials, and every request that was answered carried a token
      // that the stand-in minted for this one repository with the Contents read right only.
      const requests = host.requests.filter(
        (request) => request.repository === REPOSITORY.fullName,
      );
      expect(requests.some((request) => request.credentials === 'anonymous')).toBe(true);
      expect(requests.some((request) => request.credentials === 'accepted')).toBe(true);
      expect(requests.some((request) => request.credentials === 'refused')).toBe(false);
      const used = host.acceptedTokens();
      // Counted, never printed: a failure message must not carry a token.
      expect(used.length).toBe(1);
      // Revoked by the API once the Worker reported the result, so it no longer opens anything.
      await expect.poll(() => github.state.installationTokens.has(used[0] ?? ''), WAIT).toBe(false);
      const grants = github.state.requests.filter(
        (request) =>
          request.method === 'POST' && /\/access_tokens$/.test(request.path) && request.body,
      );
      const mintBodies = grants.map((request) => request.body as Record<string, unknown>);
      expect(mintBodies.at(-1)).toMatchObject({
        repository_ids: [REPOSITORY.id],
        permissions: { contents: 'read' },
      });
      expect(Object.keys(mintBodies.at(-1)?.permissions ?? {})).toEqual(['contents']);

      // The token is in no place that Atlas keeps: the API's log, the Worker's state or the clone.
      const secretIn = async (path: string) => {
        const names = await readdir(path, { recursive: true, withFileTypes: true });
        for (const entry of names) {
          if (!entry.isFile()) continue;
          const content = await readFile(join(entry.parentPath, entry.name)).catch(() => null);
          if (content && used.some((token) => content.includes(token))) return true;
        }
        return false;
      };
      expect(api.logLines.some((line) => used.some((token) => line.includes(token)))).toBe(false);
      expect(await secretIn(join(directory, 'state'))).toBe(false);
      expect(await secretIn(join(target, '.git'))).toBe(false);

      // A session on the cloned project starts in a worktree that holds the files.
      const [version] = VersionListResponseSchema.parse(
        await getJson(`/api/v1/projects/${created.project.id}/versions`),
      ).items;
      const taskResponse = await api.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${created.project.id}/versions/${version?.id}/tasks`,
        headers: { cookie: api.owner },
        payload: { title: 'Work on the clone' },
      });
      expect(taskResponse.statusCode).toBeLessThan(300);
      const taskId = TaskResponseSchema.parse(taskResponse.json<unknown>()).task.id;
      const board = await openBoard(taskId);
      await expect.poll(() => board.session?.state, WAIT).toBe('none');
      board.socket.send(JSON.stringify({ type: 'start', cols: 80, rows: 24 }));
      await expect.poll(() => board.session?.state, WAIT).toBe('running');
      expect(board.session).toMatchObject({ branch: `atlas/task-${taskId}` });
      await expect.poll(() => board.output, WAIT).toContain('READY');
      const worktree = board.session?.worktreePath ?? '';
      expect(worktree.startsWith(root())).toBe(true);
      await access(join(worktree, 'README.md'));
      expect(await readFile(join(worktree, 'src/nested/file.txt'), 'utf8')).toBe(
        'nested content\n',
      );
      board.socket.send(JSON.stringify({ type: 'stop' }));
      await expect.poll(() => board.session?.state, WAIT).toBe('exited');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops within five seconds in the middle of a clone and leaves it needing attention',
    async () => {
      const created = await create('stalled', SLOW.id);
      // The Worker is mid-clone once Git's fetch has reached the host with a valid token.
      await expect
        .poll(
          () =>
            host.requests.filter(
              (request) => request.repository === SLOW.fullName && request.stalled,
            ).length,
          WAIT,
        )
        .toBe(1);
      expect((await project(created.project.id)).state).toBe('pending');

      const began = Date.now();
      await worker?.stop();
      worker = undefined;
      expect(Date.now() - began).toBeLessThan(STOP_LIMIT_MS);

      // The folder is kept for inspection, and the interrupted clone is never reported as done.
      expect((await readdir(root())).includes('stalled')).toBe(true);
      expect((await project(created.project.id)).state).not.toBe('ready');

      worker = launchWorker();
      await expect.poll(online, WAIT).toBe(1);
      await expect
        .poll(async () => (await project(created.project.id)).state, WAIT)
        .toBe('needs_attention');
      const operation = OperationResponseSchema.parse(
        await getJson(`/api/v1/operations/${created.operation?.id}`),
      ).operation;
      expect(operation.state).toBe('needs_attention');
      // Nothing fetched the repository again: recovery inspects, it does not clone anew.
      expect(
        host.requests.filter((request) => request.repository === SLOW.fullName && request.stalled),
      ).toHaveLength(1);
      expect((await project(created.project.id)).state).toBe('needs_attention');
    },
    TEST_TIMEOUT_MS,
  );
});
