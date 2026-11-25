import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryCloneCommand } from '@atlas/contracts';
import { Journal } from '../src/state/journal.js';
import { cloneRepository, credentialHelperPath } from '../src/repositories/clone.js';
import { CredentialRefused } from '../src/repositories/credential.js';
import type { CredentialRequester } from '../src/repositories/credential.js';
import { startGitServer } from './support/git-server.js';
import type { GitServer } from './support/git-server.js';

const run = promisify(execFile);
const TOKEN = `ghs_${randomUUID().replaceAll('-', '')}`;

let directory: string;
let root: string;
let state: string;
let logs: string;
let wrapper: string;
let journal: Journal;
let server: GitServer;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-clone-')));
  root = join(directory, 'repos');
  state = join(directory, 'state');
  logs = join(directory, 'logs');
  await mkdir(root);
  await mkdir(state);
  await mkdir(logs);
  journal = new Journal(state);
  server = await startGitServer({ token: TOKEN });
  // Runs real Git after logging its process ID, arguments, environment names and whether any
  // environment value holds the token. The log lives outside the target and the journal.
  const realGit = (await run('sh', ['-c', 'command -v git'])).stdout.trim();
  wrapper = join(directory, 'git-wrapper.sh');
  await writeFile(
    wrapper,
    [
      '#!/bin/sh',
      `log="${logs}/$$"`,
      'for argument in "$@"; do printf "%s\\n" "$argument"; done > "$log.args"',
      'env | sed -n "s/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p" > "$log.env"',
      `if env | grep -qF -e '${TOKEN}'; then echo yes > "$log.holds"; fi`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(wrapper, 0o755);
});

afterEach(async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

function command(relativePath = 'project', repository = 'team/project'): RepositoryCloneCommand {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    type: 'command.dispatch',
    commandId: randomUUID(),
    payload: { kind: 'repository.clone', projectId: 'p1', relativePath, repository },
  };
}

const grant =
  (token = TOKEN, repository = 'team/project'): CredentialRequester =>
  () =>
    Promise.resolve({
      token,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      repository,
    });

function context(overrides: Record<string, unknown> = {}) {
  return {
    root,
    journal,
    git: wrapper,
    gitHostUrl: server.url,
    requestCredential: grant(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Invocation {
  pid: number;
  args: string[];
  env: string[];
  holdsToken: boolean;
}

async function invocations(): Promise<Invocation[]> {
  const names = await readdir(logs);
  const pids = [...new Set(names.map((name) => name.split('.')[0] ?? ''))];
  return Promise.all(
    pids.map(async (pid) => ({
      pid: Number(pid),
      args: (await readFile(join(logs, `${pid}.args`), 'utf8')).split('\n').filter(Boolean),
      env: (await readFile(join(logs, `${pid}.env`), 'utf8')).split('\n').filter(Boolean),
      holdsToken: names.includes(`${pid}.holds`),
    })),
  );
}

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function anyFileContains(path: string, needles: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of await filesUnder(path)) {
    const content = await readFile(file);
    if (needles.some((needle) => content.includes(needle))) found.push(file);
  }
  return found;
}

const tokenForms = [TOKEN, Buffer.from(`x-access-token:${TOKEN}`).toString('base64')];

describe('cloneRepository', () => {
  it('clones with the granted token and keeps the token out of files, arguments and checkout', async () => {
    await server.addRepository('team/project', { 'README.md': '# Project\n', 'src/a.txt': 'a' });
    const job = command();
    let accepted = 0;
    const outcome = await cloneRepository(job, context({ onAccepted: () => accepted++ }));
    const target = join(root, 'project');
    expect(outcome).toEqual({ status: 'succeeded', localPath: target });
    expect(accepted).toBe(1);
    expect(await readFile(join(target, 'README.md'), 'utf8')).toBe('# Project\n');
    expect(await readFile(join(target, 'src', 'a.txt'), 'utf8')).toBe('a');

    expect(await anyFileContains(target, tokenForms)).toEqual([]);
    expect(await anyFileContains(state, tokenForms)).toEqual([]);
    const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: target });
    expect(origin.stdout.trim()).toBe(`${server.url}/team/project`);
    const config = await readFile(join(target, '.git', 'config'), 'utf8');
    expect(config).not.toContain('credential');
    const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target });
    expect(branch.stdout.trim()).toBe('main');
    const tags = await run('git', ['tag', '--list'], { cwd: target });
    expect(tags.stdout.trim()).toBe('v1');

    const calls = await invocations();
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call.args.some((arg) => arg.includes(TOKEN))).toBe(false);
    const holders = calls.filter((call) => call.holdsToken);
    expect(holders).toHaveLength(2);
    for (const holder of holders) {
      expect(holder.args).not.toContain('checkout');
      expect(holder.args.some((arg) => arg === 'fetch' || arg === 'ls-remote')).toBe(true);
      // No background maintenance that could inherit the token, no weakened TLS, no extra headers.
      for (const setting of [
        'maintenance.auto=false',
        'gc.auto=0',
        'fetch.writeCommitGraph=false',
        'http.sslVerify=true',
        'http.extraHeader=',
        `safe.directory=${target}`,
      ])
        expect(holder.args).toContain(setting);
      expect(holder.env).toContain('GIT_CONFIG_NOSYSTEM');
    }
    const checkout = calls.find((call) => call.args.includes('checkout'));
    expect(checkout?.holdsToken).toBe(false);
    expect(checkout?.env.some((name) => name.startsWith('ATLAS_'))).toBe(false);
    expect(journal.get(job.commandId)).toMatchObject({ stage: 'finished', outcome });
    expect(server.requests.some((request) => request.authorized)).toBe(true);
  });

  it('clones an empty repository as an empty checkout', async () => {
    await server.addRepository('team/empty');
    const outcome = await cloneRepository(
      command('empty', 'team/empty'),
      context({ requestCredential: grant(TOKEN, 'team/empty') }),
    );
    const target = join(root, 'empty');
    expect(outcome).toEqual({ status: 'succeeded', localPath: target });
    expect(await readdir(target)).toEqual(['.git']);
    const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: target });
    expect(origin.stdout.trim()).toBe(`${server.url}/team/empty`);
  });

  it('fails a grant for another repository without contacting the Git host', async () => {
    await server.addRepository('team/project', { 'README.md': 'x' });
    const outcome = await cloneRepository(
      command(),
      context({ requestCredential: grant(TOKEN, 'team/renamed') }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.status !== 'succeeded' && outcome.error.code).toBe('repository_renamed');
    expect(server.requests).toEqual([]);
  });

  it('fails with the refusal message', async () => {
    const outcome = await cloneRepository(
      command(),
      context({
        requestCredential: () =>
          Promise.reject(
            new CredentialRefused('not_linked', 'The project has no linked repository'),
          ),
      }),
    );
    expect(outcome).toEqual({
      status: 'failed',
      error: { code: 'not_linked', message: 'The project has no linked repository' },
    });
    expect(server.requests).toEqual([]);
  });

  it('needs attention when no credential reply arrives in time', async () => {
    const outcome = await cloneRepository(
      command(),
      context({
        requestCredential: () => new Promise<never>(() => {}),
        credentialTimeoutMs: 200,
      }),
    );
    expect(outcome.status).toBe('needs_attention');
    expect(server.requests).toEqual([]);
  });

  it('ends Git promptly when aborted during a stalled fetch, then needs attention', async () => {
    const sockets = new Set<Socket>();
    let reached: () => void = () => {};
    const firstRequest = new Promise<void>((resolve) => (reached = resolve));
    const stalled = createServer(() => reached());
    stalled.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    stalled.listen(0, '127.0.0.1');
    await once(stalled, 'listening');
    const address = stalled.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    try {
      const controller = new AbortController();
      const job = command();
      const pending = cloneRepository(
        job,
        context({ gitHostUrl: `http://127.0.0.1:${address.port}`, signal: controller.signal }),
      );
      await firstRequest;
      const started = Date.now();
      controller.abort();
      const outcome = await pending;
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(outcome.status).toBe('needs_attention');
      for (const call of await invocations()) {
        expect(() => process.kill(call.pid, 0)).toThrow();
      }
      const again = await cloneRepository(
        { ...job, messageId: randomUUID() },
        context({ gitHostUrl: `http://127.0.0.1:${address.port}` }),
      );
      expect(again.status).toBe('needs_attention');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });

  it('fails on an existing target folder and leaves it untouched', async () => {
    await server.addRepository('team/project', { 'README.md': 'x' });
    await mkdir(join(root, 'project'));
    await writeFile(join(root, 'project', 'keep.txt'), 'keep');
    let asked = 0;
    const outcome = await cloneRepository(
      command(),
      context({
        requestCredential: (...args: Parameters<CredentialRequester>) => {
          asked++;
          return grant()(...args);
        },
      }),
    );
    expect(outcome.status).toBe('failed');
    expect(asked).toBe(0);
    expect(await readdir(join(root, 'project'))).toEqual(['keep.txt']);
    expect(server.requests).toEqual([]);
  });

  it('fails with a wrong token and does not echo it', async () => {
    await server.addRepository('team/project', { 'README.md': 'x' });
    const wrong = `ghs_wrong_${randomUUID()}`;
    const outcome = await cloneRepository(command(), context({ requestCredential: grant(wrong) }));
    expect(outcome.status).toBe('failed');
    expect(JSON.stringify(outcome)).not.toContain(wrong);
    expect(JSON.stringify(journal.entries())).not.toContain(wrong);
  });

  it('ignores a hostile system Git configuration in the processes that hold the token', async () => {
    await server.addRepository('team/project', { 'README.md': 'x' });
    const marker = join(directory, 'hostile-helper-ran');
    const system = join(directory, 'hostile-system.gitconfig');
    await writeFile(
      system,
      [
        '[credential]',
        `\thelper = "!touch '${marker}'"`,
        '[http]',
        '\textraHeader = X-Atlas-Hostile: 1',
        '\tsslVerify = false',
        `[http "${server.url}"]`,
        '\textraHeader = X-Atlas-Url-Hostile: 1',
        '',
      ].join('\n'),
    );
    // Stands in for a system configuration at Git's default location: the variable is set for
    // every Git process the clone starts, after the Worker has built their environment.
    const hostile = join(directory, 'git-hostile.sh');
    await writeFile(
      hostile,
      `#!/bin/sh\nGIT_CONFIG_SYSTEM='${system}'\nexport GIT_CONFIG_SYSTEM\nexec '${wrapper}' "$@"\n`,
    );
    await chmod(hostile, 0o755);
    const outcome = await cloneRepository(command(), context({ git: hostile }));
    expect(outcome.status).toBe('succeeded');
    await expect(readFile(marker)).rejects.toThrow();
    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests) {
      expect(request.headers['x-atlas-hostile']).toBeUndefined();
      expect(request.headers['x-atlas-url-hostile']).toBeUndefined();
    }
  });

  it('starts nothing when the Worker stopped before the clone began', async () => {
    await server.addRepository('team/project', { 'README.md': 'x' });
    const controller = new AbortController();
    controller.abort();
    const job = command();
    let accepted = 0;
    const outcome = await cloneRepository(
      job,
      context({ signal: controller.signal, onAccepted: () => accepted++ }),
    );
    expect(outcome.status).toBe('needs_attention');
    expect(accepted).toBe(0);
    expect(await readdir(root)).toEqual([]);
    expect(journal.get(job.commandId)).toBeNull();
    expect(server.requests).toEqual([]);
  });

  it('fails a dot-prefixed target', async () => {
    const outcome = await cloneRepository(command('.x/y'), context());
    expect(outcome.status).toBe('failed');
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['team/..', 'team/.'])('fails the repository name %s', async (repository) => {
    const outcome = await cloneRepository(command('project', repository), context());
    expect(outcome.status).toBe('failed');
    expect(await readdir(root)).toEqual([]);
    expect(server.requests).toEqual([]);
  });
});

describe('credential helper', () => {
  async function ask(args: string[], input: string, env: NodeJS.ProcessEnv) {
    const child = spawn('/bin/sh', [credentialHelperPath, ...args], {
      env: { PATH: process.env.PATH, ...env },
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stdin.end(input);
    await once(child, 'close');
    return output;
  }

  it('answers only for the configured protocol and host', async () => {
    const env = { ATLAS_GIT_TOKEN: TOKEN };
    expect(
      await ask(['https', 'github.com', 'get'], 'protocol=https\nhost=github.com\n\n', env),
    ).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(
      await ask(['https', 'github.com', 'get'], 'protocol=https\nhost=evil.example\n\n', env),
    ).toBe('');
    expect(
      await ask(['https', 'github.com', 'get'], 'protocol=http\nhost=github.com\n\n', env),
    ).toBe('');
    expect(
      await ask(['https', 'github.com', 'store'], 'protocol=https\nhost=github.com\n\n', env),
    ).toBe('');
    expect(
      await ask(['https', 'github.com', 'get'], 'protocol=https\nhost=github.com\n\n', {}),
    ).toBe('');
  });
});
