import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  IMPORT_FAILED,
  agentObjectEnvironment,
  alternatesEntry,
  importTaskObjects,
  readTaskTip,
  startObjectSync,
} from '../src/sessions/objects.js';
import { ensureWorktree } from '../src/sessions/worktree.js';
import type { Worktree } from '../src/sessions/worktree.js';
import { createHarness, startPayload } from './support/sessions.js';
import type { Harness } from './support/sessions.js';

const run = promisify(execFile);
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

let directory: string;
let root: string;
let harness: Harness | undefined;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-objects-')));
  root = join(directory, 'repos');
});

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  await rm(directory, { recursive: true, force: true });
});

// Git as the user runs it in the project folder: no agent object folder in sight.
async function git(cwd: string, ...args: string[]) {
  return (await run('git', [...identity, ...args], { cwd })).stdout.trim();
}

// Git as the agent runs it in its worktree.
async function agentGit(worktree: Worktree, ...args: string[]) {
  const env = { ...process.env, ...agentObjectEnvironment(worktree) };
  return (await run('git', [...identity, ...args], { cwd: worktree.path, env })).stdout.trim();
}

async function project(relativePath = 'app') {
  const repo = join(root, relativePath);
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '--quiet', '-b', 'main');
  await writeFile(join(repo, 'main.txt'), 'main\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '--quiet', '-m', 'chore: seed');
  const worktree = await ensureWorktree(root, repo, startPayload(randomUUID(), relativePath));
  return { repo, worktree };
}

async function agentCommit(worktree: Worktree, file: string, text: string) {
  await writeFile(join(worktree.path, file), text);
  await agentGit(worktree, 'add', '-A');
  await agentGit(worktree, 'commit', '--quiet', '-m', `feat: ${file}`);
  return agentGit(worktree, 'rev-parse', 'HEAD');
}

async function files(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const objectFile = (folder: string, name: string) => join(folder, name.slice(0, 2), name.slice(2));

describe("the agent's own object folder", () => {
  it('is created inside the Git folder of the worktree', async () => {
    const { worktree } = await project();
    expect(worktree.objectDir).toBe(join(worktree.gitDir, 'objects'));
    expect(await files(worktree.objectDir)).toEqual([]);
  });

  it("takes the agent's commits and leaves the project's object store unchanged", async () => {
    const { repo, worktree } = await project();
    const shared = join(worktree.commonDir, 'objects');
    const before = await files(shared);

    const tip = await agentCommit(worktree, 'work.txt', 'work\n');

    expect(await files(shared)).toEqual(before);
    expect(await files(worktree.objectDir)).toHaveLength(3);
    // The project folder cannot use the commit until the Worker has copied it.
    await expect(git(repo, 'cat-file', '-e', tip)).rejects.toThrow();
  });
});

describe('importTaskObjects', () => {
  it("copies the task branch's new objects so the project folder can use it", async () => {
    const { repo, worktree } = await project();
    const tip = await agentCommit(worktree, 'work.txt', 'work\n');

    expect(await importTaskObjects(root, worktree)).toBe(tip);

    expect(await git(repo, 'log', '--format=%s', worktree.branch)).toBe(
      'feat: work.txt\nchore: seed',
    );
    expect(await git(repo, 'show', `${worktree.branch}:work.txt`)).toBe('work');
    await git(repo, 'fsck', '--strict');
  });

  it('copies again when the branch has moved since an earlier copy', async () => {
    const { repo, worktree } = await project();
    const first = await importTaskObjects(root, worktree, undefined);
    expect(await importTaskObjects(root, worktree, first)).toBe(first);

    const second = await agentCommit(worktree, 'more.txt', 'more\n');

    expect(await importTaskObjects(root, worktree, first)).toBe(second);
    expect(await git(repo, 'show', `${worktree.branch}:more.txt`)).toBe('more');
  });

  it('succeeds for a branch with no commits of its own', async () => {
    const { repo, worktree } = await project();
    expect(await importTaskObjects(root, worktree)).toBe(await git(repo, 'rev-parse', 'main'));
  });

  it('refuses changed content under the name of another object', async () => {
    const { repo, worktree } = await project();
    await agentCommit(worktree, 'work.txt', 'real\n');
    const real = await agentGit(worktree, 'rev-parse', 'HEAD:work.txt');
    const forged = await agentGit(worktree, 'hash-object', '-w', join(repo, 'main.txt'));
    // The forged file sits in the agent's folder under the name of the real one.
    const target = objectFile(worktree.objectDir, real);
    await chmod(target, 0o644);
    await copyFile(objectFile(join(worktree.commonDir, 'objects'), forged), target);

    await expect(importTaskObjects(root, worktree)).rejects.toThrow();

    // Nothing in the project's store answers to the forged name.
    await expect(git(repo, 'cat-file', '-e', real)).rejects.toThrow();
    await expect(git(repo, 'show', 'main:main.txt')).resolves.toBe('main');
  });

  it("does not let an agent's object replace one the project already has", async () => {
    const { repo, worktree } = await project();
    const mainBlob = await git(repo, 'rev-parse', 'main:main.txt');
    // The agent keeps different content under the name of the project's file and commits on top.
    await writeFile(join(worktree.path, 'evil.txt'), 'evil\n');
    const evil = await agentGit(worktree, 'hash-object', '-w', 'evil.txt');
    await mkdir(join(worktree.objectDir, mainBlob.slice(0, 2)), { recursive: true });
    await copyFile(objectFile(worktree.objectDir, evil), objectFile(worktree.objectDir, mainBlob));
    await agentCommit(worktree, 'work.txt', 'work\n');

    await importTaskObjects(root, worktree);

    expect(await git(repo, 'show', 'main:main.txt')).toBe('main');
    expect(await git(repo, 'show', `${worktree.branch}:main.txt`)).toBe('main');
    await git(repo, 'fsck', '--strict');
  });

  it('reports a task branch that does not point at a commit', async () => {
    const { worktree } = await project();
    await writeFile(join(worktree.commonDir, 'refs', 'heads', worktree.branch), 'garbage\n');

    await expect(importTaskObjects(root, worktree)).rejects.toThrow(
      'the task branch does not point at a commit',
    );
  });

  it('does not follow a task branch file that is a link', async () => {
    const { repo, worktree } = await project();
    const ref = join(worktree.commonDir, 'refs', 'heads', worktree.branch);
    await rm(ref);
    await symlink(join(repo, '.git', 'refs', 'heads', 'main'), ref);

    await expect(importTaskObjects(root, worktree)).rejects.toThrow(
      'the task branch does not point at a commit',
    );
  });

  it('does not wait on a task branch file that is a pipe', async () => {
    const { worktree } = await project();
    const ref = join(worktree.commonDir, 'refs', 'heads', worktree.branch);
    await rm(ref);
    await run('mkfifo', [ref]);

    const started = Date.now();
    await expect(importTaskObjects(root, worktree)).rejects.toThrow(
      'the task branch does not point at a commit',
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses a task branch that names a tag instead of a commit', async () => {
    const { worktree } = await project();
    const tag = await agentGit(worktree, 'tag', '-a', '-m', 'tag', 'probe').then(() =>
      agentGit(worktree, 'rev-parse', 'refs/tags/probe'),
    );
    await writeFile(join(worktree.commonDir, 'refs', 'heads', worktree.branch), `${tag}\n`);

    await expect(importTaskObjects(root, worktree)).rejects.toThrow(
      'the task branch does not point at a commit',
    );
  });

  it('reads a task branch that Git has packed', async () => {
    const { repo, worktree } = await project();
    const tip = await agentCommit(worktree, 'work.txt', 'work\n');
    await importTaskObjects(root, worktree);
    await git(repo, 'pack-refs', '--all');

    expect(await readTaskTip(worktree)).toBe(tip);
    expect(await importTaskObjects(root, worktree)).toBe(tip);
  });

  it('works for a project path that contains a colon and a space', async () => {
    const { repo, worktree } = await project('team:a/my app');
    expect(alternatesEntry(worktree.objectDir)).toBe(`"${worktree.objectDir}"`);
    await agentCommit(worktree, 'work.txt', 'work\n');

    await importTaskObjects(root, worktree);

    expect(await git(repo, 'show', `${worktree.branch}:work.txt`)).toBe('work');
  });
});

describe('alternatesEntry', () => {
  it('quotes only paths Git would split or read as quoted', () => {
    expect(alternatesEntry('/srv/my repos/app/.git/objects')).toBe(
      '/srv/my repos/app/.git/objects',
    );
    expect(alternatesEntry('/srv/a:b')).toBe('"/srv/a:b"');
    expect(alternatesEntry('"odd"/x')).toBe('"\\"odd\\"/x"');
    expect(alternatesEntry('/srv/a:b\\c')).toBe('"/srv/a:b\\\\c"');
  });
});

describe('startObjectSync', () => {
  it('copies new commits while it runs and once more when it finishes', async () => {
    const { repo, worktree } = await project();
    const sync = startObjectSync(root, worktree, 25);
    try {
      await agentCommit(worktree, 'work.txt', 'work\n');
      await expect
        .poll(() => git(repo, 'show', `${worktree.branch}:work.txt`).catch(() => null), {
          timeout: 10_000,
        })
        .toBe('work');
    } finally {
      expect(await sync.finish()).toBeNull();
    }
  });

  it('reports why the last copy failed', async () => {
    const { worktree } = await project();
    const sync = startObjectSync(root, worktree, 60_000);
    await writeFile(join(worktree.commonDir, 'refs', 'heads', worktree.branch), 'garbage\n');

    expect(await sync.finish()).toBe(
      `${IMPORT_FAILED}: the task branch does not point at a commit`,
    );
  });
});

describe('a session', () => {
  it('reports its exit code together with a failed copy, once', async () => {
    harness = await createHarness({ objectSyncMs: 60_000 });
    const repo = await harness.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    await harness.manager.start(payload);
    await harness.waitForOutput(payload.sessionId, 'READY');
    await writeFile(
      join(repo, '.git', 'refs', 'heads', 'atlas', `task-${payload.sessionId}`),
      'garbage\n',
    );

    harness.manager.input(payload.sessionId, payload.runId, 'exit 3\n');
    const exit = await harness.waitFor('session.exit', payload.sessionId);

    expect(exit.payload).toMatchObject({
      exitCode: 3,
      message: `${IMPORT_FAILED}: the task branch does not point at a commit`,
    });
  });

  it('keeps its real exit when input arrives while the last commits are copied', async () => {
    harness = await createHarness({ objectSyncMs: 60_000 });
    await harness.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    const { manager } = harness;
    await manager.start(payload);
    await harness.waitForOutput(payload.sessionId, 'READY');
    manager.input(payload.sessionId, payload.runId, 'commit\n');
    await harness.waitForOutput(payload.sessionId, 'COMMITTED');

    manager.input(payload.sessionId, payload.runId, 'exit 3\n');
    // Input that finds the agent gone but the copy still running must not be reported as a
    // missing session, which the API would take for the exit.
    const typing = setInterval(() => manager.input(payload.sessionId, payload.runId, ''), 1);
    try {
      const exit = await harness.waitFor('session.exit', payload.sessionId);
      expect(exit.payload).toMatchObject({ exitCode: 3, message: null });
    } finally {
      clearInterval(typing);
    }
  });

  it("has the agent's commit in the project repository when it reports the exit", async () => {
    // The interval is long, so only the copy at the exit can have brought the commit over.
    harness = await createHarness({ objectSyncMs: 60_000 });
    const repo = await harness.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    await harness.manager.start(payload);
    await harness.waitForOutput(payload.sessionId, 'READY');
    harness.manager.input(payload.sessionId, payload.runId, 'commit\n');
    await harness.waitForOutput(payload.sessionId, 'COMMITTED');
    await expect(git(repo, 'log', '-1', `atlas/task-${payload.sessionId}`)).rejects.toThrow();

    harness.manager.input(payload.sessionId, payload.runId, 'exit 0\n');
    const exit = await harness.waitFor('session.exit', payload.sessionId);

    expect(exit.payload).toMatchObject({ exitCode: 0, message: null });
    expect(await git(repo, 'log', '-1', '--format=%s', `atlas/task-${payload.sessionId}`)).toBe(
      'agent work',
    );
  });

  it("has the agent's commit in the project repository while it still runs", async () => {
    harness = await createHarness({ objectSyncMs: 25 });
    const repo = await harness.initRepository('app');
    const payload = startPayload(randomUUID(), 'app');
    await harness.manager.start(payload);
    await harness.waitForOutput(payload.sessionId, 'READY');

    harness.manager.input(payload.sessionId, payload.runId, 'commit\n');

    await expect
      .poll(
        () =>
          git(repo, 'log', '-1', '--format=%s', `atlas/task-${payload.sessionId}`).catch(
            () => null,
          ),
        { timeout: 10_000 },
      )
      .toBe('agent work');
    expect(harness.events.some((event) => event.type === 'session.exit')).toBe(false);
  });
});
