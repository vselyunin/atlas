import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_GRANT_WINDOW_MS } from '@atlas/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { githubLinks, operations, projects, workers } from '../src/db/schema.js';
import { AppFile } from '../src/github/app-file.js';
import { GitHubClient } from '../src/github/client.js';
import { CredentialBroker } from '../src/github/credentials.js';
import type { BrokerTimers } from '../src/github/credentials.js';
import { ApiError } from '../src/http/errors.js';
import { REPOSITORY, resetStandIn, startCloneApi } from './support/clone-api.js';
import type { CloneApi } from './support/clone-api.js';
import { connectWorker } from './support/fake-worker.js';
import type { FakeWorker } from './support/fake-worker.js';
import { startGithubStandIn } from './support/github-stand-in.js';
import type { GithubStandIn } from './support/github-stand-in.js';

const START = Date.parse('2026-11-25T10:00:00.000Z');

let github: GithubStandIn;
let api: CloneApi;
let clock: number;
const fakes: FakeWorker[] = [];

beforeAll(async () => {
  github = await startGithubStandIn();
});
afterAll(async () => {
  await github.close();
});

async function worker(options: Parameters<typeof connectWorker>[1] = {}) {
  const connected = await connectWorker(api.app, options);
  fakes.push(connected);
  return connected;
}

// Creates a project that clones the stand-in's repository and returns its dispatched command.
async function dispatchedClone(fake: FakeWorker, relativePath = 'repo') {
  const response = await api.create({
    mode: 'local',
    workerId: fake.workerId,
    relativePath,
    githubRepositoryId: REPOSITORY.id,
  });
  expect(response.statusCode).toBe(202);
  return fake.next('command.dispatch');
}

function contentsTokenRequests() {
  return github.state.requests.filter(
    (request) =>
      request.method === 'POST' &&
      /\/access_tokens$/.test(request.path) &&
      JSON.stringify(request.body).includes('"contents"'),
  );
}

function revocations(token: string) {
  return github.state.requests.filter(
    (request) =>
      request.method === 'DELETE' &&
      request.path.endsWith('/installation/token') &&
      request.authorization === `Bearer ${token}`,
  );
}

// Waits until the API has noticed that a Worker's socket closed.
async function waitOffline(workerId: string) {
  await untilAsync(async () => {
    const response = await api.app.inject({
      url: '/api/v1/workers',
      headers: { cookie: api.owner },
    });
    const { items } = response.json<{ items: Array<{ id: string; availability: string }> }>();
    return items.find((item) => item.id === workerId)?.availability === 'offline';
  });
}

async function untilAsync(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition not reached');
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition not reached');
}

describe('the credential broker over the Worker socket', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    resetStandIn(github);
    clock = START;
    api = await startCloneApi(github, { now: () => new Date(clock) });
  }, 30_000);
  afterEach(async () => {
    for (const fake of fakes.splice(0)) await fake.close();
    await api.close();
  });

  it('grants a one-repository, read-only token on the dispatching connection', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    const reply = await fake.requestCredential(dispatch.commandId);
    expect(reply.type).toBe('credential.grant');
    if (reply.type !== 'credential.grant') return;
    expect(reply.payload.repository).toBe(REPOSITORY.fullName);
    const issued = github.state.installationTokens.get(reply.payload.token);
    expect(issued?.repositoryIds).toEqual([REPOSITORY.id]);
    expect(issued?.permissions).toEqual({ contents: 'read' });
    expect(Date.parse(reply.payload.expiresAt)).toBe(Date.parse(issued?.expiresAt ?? ''));

    const requested = contentsTokenRequests();
    expect(requested).toHaveLength(1);
    expect(requested[0]?.body).toEqual({
      repository_ids: [REPOSITORY.id],
      permissions: { contents: 'read' },
    });
  });

  it('refuses an unknown command', async () => {
    const fake = await worker();
    const reply = await fake.requestCredential('no-such-command');
    expect(reply).toMatchObject({
      type: 'credential.refusal',
      payload: { code: 'unknown_command' },
    });
  });

  it('refuses a finished command', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    fake.send({
      type: 'command.result',
      commandId: dispatch.commandId,
      payload: { status: 'failed', error: { code: 'clone_failed', message: 'Clone failed' } },
    });
    await fake.next('command.result_ack');
    const reply = await fake.requestCredential(dispatch.commandId);
    expect(reply).toMatchObject({
      type: 'credential.refusal',
      payload: { code: 'command_finished' },
    });
  });

  it('refuses an init command', async () => {
    const fake = await worker();
    await api.create({ mode: 'local', workerId: fake.workerId, relativePath: 'fresh' }, 'Fresh');
    const dispatch = await fake.next('command.dispatch');
    expect(dispatch.payload.kind).toBe('repository.init');
    const reply = await fake.requestCredential(dispatch.commandId);
    expect(reply).toMatchObject({ type: 'credential.refusal', payload: { code: 'wrong_kind' } });
  });

  it("refuses another Worker's command without naming it", async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    const other = await worker({ workerId: 'atlas:other', workspaceRoot: '/tmp/atlas-other' });
    const reply = await other.requestCredential(dispatch.commandId);
    expect(reply).toMatchObject({
      type: 'credential.refusal',
      payload: { code: 'wrong_connection' },
    });
    expect(JSON.stringify(reply)).not.toContain(REPOSITORY.fullName);
    expect(JSON.stringify(reply)).not.toContain('repo');
    expect(contentsTokenRequests()).toEqual([]);
  });

  it('refuses a second request after a grant', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    expect((await fake.requestCredential(dispatch.commandId)).type).toBe('credential.grant');
    const reply = await fake.requestCredential(dispatch.commandId);
    expect(reply).toMatchObject({
      type: 'credential.refusal',
      payload: { code: 'already_granted' },
    });
    expect(contentsTokenRequests()).toHaveLength(1);
  });

  it('refuses a request after the grant window', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    clock = START + CREDENTIAL_GRANT_WINDOW_MS + 1000;
    const reply = await fake.requestCredential(dispatch.commandId);
    expect(reply).toMatchObject({
      type: 'credential.refusal',
      payload: { code: 'grant_window_closed' },
    });
    expect(contentsTokenRequests()).toEqual([]);
  });

  it('grants at the end of the window', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    clock = START + CREDENTIAL_GRANT_WINDOW_MS;
    expect((await fake.requestCredential(dispatch.commandId)).type).toBe('credential.grant');
  });

  it("refuses while the App file lies in a Worker's workspace", async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    await worker({ workerId: 'atlas:exposing', workspaceRoot: api.directory });
    const reply = await fake.requestCredential(dispatch.commandId);
    expect(reply).toMatchObject({
      type: 'credential.refusal',
      payload: { code: 'app_file_exposed' },
    });
    expect(JSON.stringify(reply)).not.toContain(api.directory);
    expect(contentsTokenRequests()).toEqual([]);
  });

  it('refuses when the App lost access to the repository', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    github.state.repositories = [];
    const reply = await fake.requestCredential(dispatch.commandId);
    expect(reply).toMatchObject({
      type: 'credential.refusal',
      payload: { code: 'repository_not_accessible' },
    });
  });

  it('refuses when GitHub fails', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    github.state.failWith = 500;
    const reply = await fake.requestCredential(dispatch.commandId);
    github.state.failWith = null;
    expect(reply).toMatchObject({
      type: 'credential.refusal',
      payload: { code: 'github_unavailable' },
    });
  });

  it('grants again after a reconnect and re-dispatch, a window later', async () => {
    const first = await worker();
    const dispatch = await dispatchedClone(first);
    const granted = await first.requestCredential(dispatch.commandId);
    expect(granted.type).toBe('credential.grant');
    await first.close();
    await waitOffline('atlas:test');
    // The window counts from the latest dispatch.
    clock = START + CREDENTIAL_GRANT_WINDOW_MS + 60_000;
    const second = await worker();
    const again = await second.next('command.dispatch');
    expect(again.commandId).toBe(dispatch.commandId);
    const reply = await second.requestCredential(dispatch.commandId);
    expect(reply.type).toBe('credential.grant');
    if (reply.type !== 'credential.grant' || granted.type !== 'credential.grant') return;
    expect(reply.payload.token).not.toBe(granted.payload.token);
  });

  it('revokes the token when the result arrives', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    const reply = await fake.requestCredential(dispatch.commandId);
    if (reply.type !== 'credential.grant') throw new Error('Expected a grant');
    const { token } = reply.payload;
    expect(revocations(token)).toEqual([]);
    fake.send({
      type: 'command.result',
      commandId: dispatch.commandId,
      payload: { status: 'succeeded', localPath: '/tmp/atlas-test/repo' },
    });
    await fake.next('command.result_ack');
    await until(() => revocations(token).length === 1);
    expect(github.state.installationTokens.has(token)).toBe(false);
  });

  it('names the current repository after a rename', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    expect(dispatch.payload).toMatchObject({ repository: REPOSITORY.fullName });
    const [repository] = github.state.repositories;
    if (repository) repository.fullName = 'octo-org/renamed';
    const reply = await fake.requestCredential(dispatch.commandId);
    expect(reply).toMatchObject({
      type: 'credential.grant',
      payload: { repository: 'octo-org/renamed' },
    });
  });

  it('logs every grant and refusal without the token', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    const reply = await fake.requestCredential(dispatch.commandId);
    if (reply.type !== 'credential.grant') throw new Error('Expected a grant');
    await fake.requestCredential(dispatch.commandId);
    await fake.requestCredential('no-such-command');
    fake.send({
      type: 'command.result',
      commandId: dispatch.commandId,
      payload: { status: 'succeeded', localPath: '/tmp/atlas-test/repo' },
    });
    await fake.next('command.result_ack');
    await until(() => revocations(reply.payload.token).length === 1);

    const entries = api.logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const grants = entries.filter((entry) => entry.msg === 'Granted a repository credential');
    const refusals = entries.filter((entry) => entry.msg === 'Refused a repository credential');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      commandId: dispatch.commandId,
      workerId: 'atlas:test',
      repository: REPOSITORY.fullName,
      rights: 'contents:read',
    });
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatchObject({
      commandId: dispatch.commandId,
      workerId: 'atlas:test',
      repository: REPOSITORY.fullName,
      rights: 'contents:read',
      code: 'already_granted',
    });
    expect(refusals[1]).toMatchObject({
      commandId: 'no-such-command',
      workerId: 'atlas:test',
      repository: null,
      code: 'unknown_command',
    });
    for (const line of api.logLines) expect(line).not.toContain(reply.payload.token);
  });
});

// The broker on its own, for what the app cannot show without waiting: the window timer, a GitHub
// that does not answer, and shutdown.
describe('the credential broker', { timeout: 30_000 }, () => {
  type Pending = { callback: () => void; ms: number; cleared: boolean };
  let directory: string;
  let database: ReturnType<typeof openDatabase>;
  let timers: Pending[];
  const socket = {} as WebSocket;
  const logged: unknown[] = [];
  const log = {
    info: (...args: unknown[]) => logged.push(args),
    warn: (...args: unknown[]) => logged.push(args),
    error: (...args: unknown[]) => logged.push(args),
  } as unknown as FastifyBaseLogger;
  const fakeTimers: BrokerTimers = {
    set(callback, ms) {
      const pending = { callback, ms, cleared: false };
      timers.push(pending);
      return { clear: () => (pending.cleared = true) };
    },
  };

  beforeEach(() => {
    resetStandIn(github);
    timers = [];
    directory = mkdtempSync(join(tmpdir(), 'atlas-broker-'));
    writeFileSync(join(directory, 'github-app.json'), JSON.stringify(github.secrets));
    database = openDatabase(':memory:', () => new Date(START).toISOString());
    const stamp = new Date(START).toISOString();
    database.db
      .insert(workers)
      .values({
        id: 'atlas:test',
        name: 'Test',
        kind: 'atlas',
        availability: 'online',
        lastSeenAt: stamp,
        workspaceRoot: '/tmp/atlas-test',
        capabilities: ['repository.init', 'agent.session', 'repository.clone'],
      })
      .run();
    database.db
      .insert(projects)
      .values({
        id: 'project-1',
        name: 'Cloned',
        repository: {
          mode: 'local',
          workerId: 'atlas:test',
          relativePath: 'repo',
          localPath: null,
        },
        state: 'pending',
        operationId: 'command-1',
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
    database.db
      .insert(operations)
      .values({
        id: 'command-1',
        projectId: 'project-1',
        kind: 'repository.clone',
        workerId: 'atlas:test',
        state: 'pending',
        connectionLost: false,
        result: null,
        error: null,
        workspaceRoot: '/tmp/atlas-test',
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
    database.db
      .insert(githubLinks)
      .values({
        projectId: 'project-1',
        repositoryId: REPOSITORY.id,
        fullName: REPOSITORY.fullName,
        defaultBranch: 'main',
        createdAt: stamp,
      })
      .run();
  });
  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function broker(budgetMs?: number) {
    return new CredentialBroker({
      context: { db: database.db, now: () => new Date(START).toISOString() },
      log,
      github: {
        appFile: new AppFile(join(directory, 'github-app.json')),
        client: new GitHubClient({ apiUrl: github.apiUrl, webUrl: github.webUrl }),
      },
      timers: fakeTimers,
      ...(budgetMs === undefined ? {} : { budgetMs }),
    });
  }

  it('revokes the token when the grant window closes, and refuses after it', async () => {
    const subject = broker();
    subject.noteDispatch('command-1', socket);
    const window = timers.find((timer) => timer.ms === CREDENTIAL_GRANT_WINDOW_MS);
    const { token } = await subject.request('command-1', 'atlas:test', socket);
    expect(github.state.installationTokens.has(token)).toBe(true);
    window?.callback();
    await until(() => !github.state.installationTokens.has(token));
    await expect(subject.request('command-1', 'atlas:test', socket)).rejects.toMatchObject({
      code: 'grant_window_closed',
    });
  });

  it('refuses in time when GitHub does not answer', async () => {
    const subject = broker(50);
    subject.noteDispatch('command-1', socket);
    github.state.failWith = 'hang';
    const asked = subject.request('command-1', 'atlas:test', socket);
    await until(() => github.state.requests.length > 0);
    const budget = timers.find((timer) => timer.ms === 50 && !timer.cleared);
    budget?.callback();
    const refused = await asked.catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'github_unavailable' });
    github.state.failWith = null;
    await subject.close();
  });

  it('revokes held tokens when it closes', async () => {
    const subject = broker();
    subject.noteDispatch('command-1', socket);
    const { token } = await subject.request('command-1', 'atlas:test', socket);
    await subject.close();
    expect(github.state.installationTokens.has(token)).toBe(false);
    expect(timers.every((timer) => timer.cleared)).toBe(true);
  });

  it('refuses a request on a connection other than the dispatching one', async () => {
    const subject = broker();
    subject.noteDispatch('command-1', socket);
    await expect(subject.request('command-1', 'atlas:test', {} as WebSocket)).rejects.toMatchObject(
      { code: 'wrong_connection' },
    );
    await subject.close();
  });

  it('keeps an earlier token across a re-dispatch and revokes both on release', async () => {
    const subject = broker();
    subject.noteDispatch('command-1', socket);
    const first = await subject.request('command-1', 'atlas:test', socket);
    const next = {} as WebSocket;
    subject.noteDispatch('command-1', next);
    const second = await subject.request('command-1', 'atlas:test', next);
    expect(github.state.installationTokens.has(first.token)).toBe(true);
    await subject.release('command-1');
    expect(github.state.installationTokens.has(first.token)).toBe(false);
    expect(github.state.installationTokens.has(second.token)).toBe(false);
  });
});
