import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_GRANT_WINDOW_MS, CREDENTIAL_REPLY_TIMEOUT_MS } from '@atlas/contracts';
import type { FastifyBaseLogger } from 'fastify';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { githubLinks, operations, projects, workers } from '../src/db/schema.js';
import { AppFile } from '../src/github/app-file.js';
import { GitHubClient } from '../src/github/client.js';
import {
  CredentialBroker,
  GITHUB_GRANT_BUDGET_MS,
  MAX_GITHUB_ATTEMPTS,
  WORKER_GIT_BUDGET_MS,
} from '../src/github/credentials.js';
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
    // The new grant replaces the first one, which is revoked.
    await until(() => revocations(granted.payload.token).length === 1);
    expect(revocations(reply.payload.token)).toEqual([]);
  });

  it('grants once for two requests sent together', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    const replies = await Promise.all([
      fake.requestCredential(dispatch.commandId),
      fake.requestCredential(dispatch.commandId),
    ]);
    expect(replies.map((reply) => reply.type).sort()).toEqual([
      'credential.grant',
      'credential.refusal',
    ]);
    expect(replies.find((reply) => reply.type === 'credential.refusal')).toMatchObject({
      payload: { code: 'already_granted' },
    });
    expect(contentsTokenRequests()).toHaveLength(1);
  });

  it("does not let one Worker revoke another's token", async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    const reply = await fake.requestCredential(dispatch.commandId);
    if (reply.type !== 'credential.grant') throw new Error('Expected a grant');
    const { token } = reply.payload;
    const other = await worker({ workerId: 'atlas:other', workspaceRoot: '/tmp/atlas-other' });

    other.send({
      type: 'command.result',
      commandId: dispatch.commandId,
      payload: { status: 'failed', error: { code: 'clone_failed', message: 'Clone failed' } },
    });
    expect(await other.next('protocol.error')).toMatchObject({
      commandId: dispatch.commandId,
      payload: { code: 'wrong_worker' },
    });
    other.send({
      type: 'command.result',
      commandId: 'no-such-command',
      payload: { status: 'failed', error: { code: 'clone_failed', message: 'Clone failed' } },
    });
    expect(await other.next('protocol.error')).toMatchObject({
      commandId: 'no-such-command',
      payload: { code: 'operation_not_found' },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(revocations(token)).toEqual([]);
    expect(github.state.installationTokens.has(token)).toBe(true);

    fake.send({
      type: 'command.result',
      commandId: dispatch.commandId,
      payload: { status: 'succeeded', localPath: '/tmp/atlas-test/repo' },
    });
    await fake.next('command.result_ack');
    await until(() => revocations(token).length === 1);
  });

  it('revokes the token when the API rejects the result', async () => {
    const fake = await worker();
    const dispatch = await dispatchedClone(fake);
    const reply = await fake.requestCredential(dispatch.commandId);
    if (reply.type !== 'credential.grant') throw new Error('Expected a grant');
    fake.send({
      type: 'command.result',
      commandId: dispatch.commandId,
      payload: { status: 'succeeded', localPath: '/somewhere/else' },
    });
    expect(await fake.next('protocol.error')).toMatchObject({
      payload: { code: 'invalid_result_path' },
    });
    await until(() => revocations(reply.payload.token).length === 1);
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

// The broker on its own, with timers driven by the test's clock: the grant window, the Git
// budget, the GitHub budget, and shutdown.
describe('the credential broker', { timeout: 30_000 }, () => {
  type Pending = {
    callback: () => void;
    ms: number;
    due: number;
    cleared: boolean;
    fired: boolean;
  };
  let directory: string;
  let database: ReturnType<typeof openDatabase>;
  let timers: Pending[];
  let releaseHold: (() => void) | undefined;
  const open = () => ({ readyState: WebSocket.OPEN }) as WebSocket;
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as FastifyBaseLogger;
  const fakeTimers: BrokerTimers = {
    set(callback, ms) {
      const pending = { callback, ms, due: clock + ms, cleared: false, fired: false };
      timers.push(pending);
      return { clear: () => (pending.cleared = true) };
    },
  };

  // Moves the clock on and runs every timer that has come due.
  function advance(ms: number) {
    clock += ms;
    for (const timer of [...timers]) {
      if (!timer.cleared && !timer.fired && timer.due <= clock) {
        timer.fired = true;
        timer.callback();
      }
    }
  }

  // Holds back GitHub's answer to the Contents token request until releaseHold runs.
  function holdContentsMint() {
    const gate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    github.state.holdWhen = (request) =>
      request.method === 'POST' &&
      request.path.endsWith('/access_tokens') &&
      JSON.stringify(request.body).includes('"contents"')
        ? gate
        : null;
  }

  function contentsToken() {
    return [...github.state.installationTokens.values()].find(
      (token) => 'contents' in token.permissions,
    )?.token;
  }

  beforeEach(() => {
    resetStandIn(github);
    clock = START;
    timers = [];
    directory = mkdtempSync(join(tmpdir(), 'atlas-broker-'));
    writeFileSync(join(directory, 'github-app.json'), JSON.stringify(github.secrets));
    database = openDatabase(':memory:', () => new Date(clock).toISOString());
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
    releaseHold?.();
    releaseHold = undefined;
    github.state.holdWhen = undefined;
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function broker() {
    return new CredentialBroker({
      context: { db: database.db, now: () => new Date(clock).toISOString() },
      log,
      github: {
        appFile: new AppFile(join(directory, 'github-app.json')),
        client: new GitHubClient({ apiUrl: github.apiUrl, webUrl: github.webUrl }),
      },
      timers: fakeTimers,
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('keeps a grant made late in the window past its close, until the result', async () => {
    const subject = broker();
    const socket = open();
    subject.noteDispatch('command-1', socket);
    advance(CREDENTIAL_GRANT_WINDOW_MS - 1000);
    const { token } = await subject.request('command-1', 'atlas:test', socket);
    advance(2000);
    await settle();
    expect(revocations(token)).toEqual([]);
    expect(github.state.installationTokens.has(token)).toBe(true);
    await subject.release('command-1');
    expect(revocations(token)).toHaveLength(1);
    expect(github.state.installationTokens.has(token)).toBe(false);
  });

  it('revokes a granted token without a result once the Git budget has passed', async () => {
    // Two Git processes of 30 minutes each, and a minute of margin.
    expect(WORKER_GIT_BUDGET_MS).toBe(61 * 60_000);
    const subject = broker();
    const socket = open();
    subject.noteDispatch('command-1', socket);
    advance(10 * 60_000);
    const { token } = await subject.request('command-1', 'atlas:test', socket);
    advance(WORKER_GIT_BUDGET_MS - 1);
    await settle();
    expect(revocations(token)).toEqual([]);
    advance(1);
    await until(() => revocations(token).length === 1);
    expect(github.state.installationTokens.has(token)).toBe(false);
    await subject.close();
  });

  it('refuses a request after the window closed', async () => {
    const subject = broker();
    const socket = open();
    subject.noteDispatch('command-1', socket);
    advance(CREDENTIAL_GRANT_WINDOW_MS + 1000);
    await expect(subject.request('command-1', 'atlas:test', socket)).rejects.toMatchObject({
      code: 'grant_window_closed',
    });
    expect(contentsTokenRequests()).toEqual([]);
  });

  it('refuses with its own message once the GitHub budget is spent', async () => {
    const subject = broker();
    const socket = open();
    subject.noteDispatch('command-1', socket);
    holdContentsMint();
    const asked = subject.request('command-1', 'atlas:test', socket);
    await until(() => contentsTokenRequests().length === 1);
    const late = contentsToken();
    if (!late) throw new Error('Expected the stand-in to have minted a token');
    const budget = timers.find((timer) => timer.ms === GITHUB_GRANT_BUDGET_MS && !timer.cleared);
    expect(budget).toBeDefined();
    // The refusal must reach the Worker before it stops waiting.
    expect(GITHUB_GRANT_BUDGET_MS).toBeLessThan(CREDENTIAL_REPLY_TIMEOUT_MS);
    advance(GITHUB_GRANT_BUDGET_MS);
    const refused = await asked.catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({
      code: 'github_unavailable',
      message: 'GitHub did not answer in time',
    });
    // The token GitHub hands out after the budget is revoked at once.
    releaseHold?.();
    await until(() => revocations(late).length === 1);
    expect(github.state.installationTokens.has(late)).toBe(false);
    await subject.close();
  });

  it('revokes a grant at once when its connection closed meanwhile', async () => {
    const subject = broker();
    const socket = { readyState: WebSocket.OPEN as number };
    subject.noteDispatch('command-1', socket as WebSocket);
    holdContentsMint();
    const asked = subject.request('command-1', 'atlas:test', socket as WebSocket);
    await until(() => contentsTokenRequests().length === 1);
    const token = contentsToken();
    if (!token) throw new Error('Expected the stand-in to have minted a token');
    socket.readyState = WebSocket.CLOSED;
    releaseHold?.();
    await expect(asked).rejects.toMatchObject({ code: 'wrong_connection' });
    await until(() => revocations(token).length === 1);
    await subject.close();
  });

  it(`asks GitHub at most ${MAX_GITHUB_ATTEMPTS} times per dispatch`, async () => {
    const subject = broker();
    const socket = open();
    subject.noteDispatch('command-1', socket);
    github.state.failWith = 500;
    for (let attempt = 0; attempt < MAX_GITHUB_ATTEMPTS; attempt += 1) {
      await expect(subject.request('command-1', 'atlas:test', socket)).rejects.toMatchObject({
        code: 'github_unavailable',
      });
    }
    const asked = github.state.requests.length;
    await expect(subject.request('command-1', 'atlas:test', socket)).rejects.toMatchObject({
      code: 'already_granted',
    });
    expect(github.state.requests).toHaveLength(asked);
    github.state.failWith = null;
    await subject.close();
  });

  it('revokes held tokens when it closes', async () => {
    const subject = broker();
    const socket = open();
    subject.noteDispatch('command-1', socket);
    const { token } = await subject.request('command-1', 'atlas:test', socket);
    await subject.close();
    expect(github.state.installationTokens.has(token)).toBe(false);
    expect(timers.every((timer) => timer.cleared || timer.fired)).toBe(true);
  });

  it('refuses a request on a connection other than the dispatching one', async () => {
    const subject = broker();
    subject.noteDispatch('command-1', open());
    await expect(subject.request('command-1', 'atlas:test', open())).rejects.toMatchObject({
      code: 'wrong_connection',
    });
    await subject.close();
  });

  it('keeps the first token across a re-dispatch until a new grant replaces it', async () => {
    const subject = broker();
    const socket = open();
    subject.noteDispatch('command-1', socket);
    const first = await subject.request('command-1', 'atlas:test', socket);
    const next = open();
    subject.noteDispatch('command-1', next);
    await settle();
    expect(github.state.installationTokens.has(first.token)).toBe(true);
    const second = await subject.request('command-1', 'atlas:test', next);
    await until(() => !github.state.installationTokens.has(first.token));
    expect(github.state.installationTokens.has(second.token)).toBe(true);
    await subject.release('command-1');
    expect(github.state.installationTokens.has(second.token)).toBe(false);
  });
});
