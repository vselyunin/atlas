import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensureWorktree } from '../src/sessions/worktree.js';
import { startPayload } from './support/sessions.js';

const run = promisify(execFile);
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

let directory: string;
let root: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-worktrees-')));
  root = join(directory, 'repos');
  await mkdir(root);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]) {
  return (await run('git', [...identity, ...args], { cwd })).stdout.trim();
}

async function repository(relativePath: string, commit = true) {
  const path = join(root, relativePath);
  await mkdir(path, { recursive: true });
  await git(path, 'init', '--quiet', '-b', 'main');
  if (commit) await git(path, 'commit', '--quiet', '--allow-empty', '-m', 'chore: seed');
  return path;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('ensureWorktree', () => {
  it('creates a worktree on a task branch for a new task', async () => {
    const repo = await repository('app');
    const id = randomUUID();
    const worktree = await ensureWorktree(root, repo, startPayload(id, 'app'));

    expect(worktree.path).toBe(join(root, '.atlas-worktrees', encodeURIComponent('app'), id));
    expect(worktree.branch).toBe(`atlas/task-${id}`);
    expect(worktree.gitDir.startsWith(`${join(repo, '.git', 'worktrees')}/`)).toBe(true);
    expect(worktree.commonDir).toBe(join(repo, '.git'));
    expect(await git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(worktree.branch);
  });

  it('returns the same worktree when called again for the same task', async () => {
    const repo = await repository('app');
    const payload = startPayload(randomUUID(), 'app');
    const first = await ensureWorktree(root, repo, payload);
    expect(await ensureWorktree(root, repo, payload)).toEqual(first);
  });

  it('reuses a worktree created under the legacy short folder name', async () => {
    const repo = await repository('team/app');
    const id = randomUUID();
    const shortKey = id.replaceAll('-', '').slice(0, 8);
    const legacy = join(root, '.atlas-worktrees', 'team__app', shortKey);
    await git(repo, 'worktree', 'add', '-b', `atlas/task-${shortKey}`, legacy);

    const worktree = await ensureWorktree(root, repo, startPayload(id, 'team/app'));

    expect(worktree.path).toBe(legacy);
    expect(worktree.branch).toBe(`atlas/task-${shortKey}`);
    expect(worktree.gitDir).toBe(await git(legacy, 'rev-parse', '--absolute-git-dir'));
    expect(worktree.gitDir.startsWith(`${join(repo, '.git', 'worktrees')}/`)).toBe(true);
  });

  it('gives an empty repository an initial commit without touching the index or hooks', async () => {
    const repo = await repository('empty', false);
    await writeFile(join(repo, 'staged.txt'), 'staged');
    await git(repo, 'add', 'staged.txt');
    const marker = join(repo, 'hook-ran');
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(hook, 0o755);

    await ensureWorktree(root, repo, startPayload(randomUUID(), 'empty'));

    const log = await git(repo, 'log', '--oneline');
    expect(log.split('\n')).toHaveLength(1);
    expect(log).toMatch(/ chore: initial commit$/);
    expect(await git(repo, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(await git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('');
    expect(await exists(marker)).toBe(false);
  });

  it('keeps nested projects and projects with double underscores apart', async () => {
    const nested = await repository('a/b');
    const flat = await repository('a__b');
    const id = randomUUID();

    const first = await ensureWorktree(root, nested, startPayload(id, 'a/b'));
    const second = await ensureWorktree(root, flat, startPayload(id, 'a__b'));

    expect(first.path).not.toBe(second.path);
    expect(first.path).toBe(join(root, '.atlas-worktrees', 'a%2Fb', id));
    expect(second.path).toBe(join(root, '.atlas-worktrees', 'a__b', id));
    expect(first.commonDir).toBe(join(nested, '.git'));
    expect(second.commonDir).toBe(join(flat, '.git'));
  });

  it('rejects a project folder that is a symlink', async () => {
    const repo = await repository('real');
    await symlink(repo, join(root, 'link'));
    await expect(
      ensureWorktree(root, join(root, 'link'), startPayload(randomUUID(), 'link')),
    ).rejects.toThrow('The project folder must be a real directory, not a link');
  });

  it('rejects a worktree folder that is a symlink', async () => {
    const repo = await repository('app');
    const elsewhere = join(directory, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, '.atlas-worktrees'));
    await expect(ensureWorktree(root, repo, startPayload(randomUUID(), 'app'))).rejects.toThrow(
      'The worktree folder must be a real directory, not a link',
    );
  });

  it('rejects a project folder inside another repository', async () => {
    await repository('outer');
    const inner = join(root, 'outer', 'inner');
    await mkdir(inner);
    await expect(
      ensureWorktree(root, inner, startPayload(randomUUID(), 'outer/inner')),
    ).rejects.toThrow('The project folder is not its own Git repository');
  });

  it('recreates a worktree folder that was deleted by hand', async () => {
    const repo = await repository('app');
    const payload = startPayload(randomUUID(), 'app');
    const first = await ensureWorktree(root, repo, payload);
    await rm(first.path, { recursive: true, force: true });

    const second = await ensureWorktree(root, repo, payload);

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
    expect(await git(second.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(first.branch);
  });

  it('works for a project path containing a space', async () => {
    const repo = await repository('my project');
    const id = randomUUID();
    const worktree = await ensureWorktree(root, repo, startPayload(id, 'my project'));
    expect(worktree.path).toBe(join(root, '.atlas-worktrees', 'my%20project', id));
    expect(await exists(join(worktree.path, '.git'))).toBe(true);
  });
});
