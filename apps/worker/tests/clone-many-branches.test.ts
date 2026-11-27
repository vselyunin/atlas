import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryCloneCommand } from '@atlas/contracts';
import { Journal } from '../src/state/journal.js';
import { cloneRepository } from '../src/repositories/clone.js';
import { startGitServer } from './support/git-server.js';
import type { GitServer } from './support/git-server.js';

const run = promisify(execFile);
const TOKEN = `ghs_${randomUUID().replaceAll('-', '')}`;
// Enough long names, all sorting before `main`, that a branch list is several times 64 KiB.
const BRANCHES = 1200;
const branchName = (index: number) => `a-${'x'.repeat(200)}-${index}`;

let directory: string;
let root: string;
let journal: Journal;
let server: GitServer;

// Git for the test's own pushes: no user or system configuration, the stand-in's credentials.
function git(args: string[], cwd: string, input?: string) {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_') && !name.startsWith('ATLAS_')) env[name] = value;
  }
  const authorization = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  const child = run(
    'git',
    ['-c', `http.extraHeader=Authorization: Basic ${authorization}`, ...args],
    {
      cwd,
      env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (input !== undefined) child.child.stdin?.end(input);
  return child;
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-clone-branches-')));
  root = join(directory, 'repos');
  await mkdir(root);
  await mkdir(join(directory, 'state'));
  journal = new Journal(join(directory, 'state'));
  server = await startGitServer({ token: TOKEN });
});

afterEach(async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

describe('cloneRepository with many branches', () => {
  it('checks out the default branch when the branch list is longer than the kept Git output', async () => {
    await server.addRepository('team/project', { 'README.md': '# Project\n' });
    const address = `${server.url}/team/project`;
    const source = join(directory, 'source');
    await mkdir(source);
    await git(['init', '--quiet', '--initial-branch=main'], source);
    await git(['fetch', '--quiet', address, 'main'], source);
    const commit = (await git(['rev-parse', 'FETCH_HEAD'], source)).stdout.trim();
    const updates = Array.from(
      { length: BRANCHES },
      (_, index) => `create refs/heads/${branchName(index)} ${commit}\n`,
    ).join('');
    await git(['update-ref', '--stdin'], source, updates);
    await git(['push', '--quiet', address, 'refs/heads/*:refs/heads/*'], source);

    const job: RepositoryCloneCommand = {
      protocolVersion: 1,
      messageId: randomUUID(),
      type: 'command.dispatch',
      commandId: randomUUID(),
      payload: {
        kind: 'repository.clone',
        projectId: 'p1',
        relativePath: 'project',
        repository: 'team/project',
      },
    };
    const outcome = await cloneRepository(job, {
      root,
      journal,
      gitHostUrl: server.url,
      requestCredential: () =>
        Promise.resolve({
          token: TOKEN,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          repository: 'team/project',
        }),
      signal: new AbortController().signal,
    });

    const target = join(root, 'project');
    expect(outcome).toEqual({ status: 'succeeded', localPath: target });
    const head = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target });
    expect(head.stdout.trim()).toBe('main');
    const remoteHead = await run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: target,
    });
    expect(remoteHead.stdout.trim()).toBe('refs/remotes/origin/main');
    const count = await run('git', ['for-each-ref', '--format=x', 'refs/remotes/origin/'], {
      cwd: target,
      maxBuffer: 16 * 1024 * 1024,
    });
    // Every pushed branch, `main` and the `origin/HEAD` pointer.
    expect(count.stdout.split('\n').filter(Boolean)).toHaveLength(BRANCHES + 2);
  }, 120_000);
});
