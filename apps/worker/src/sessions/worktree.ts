import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { SessionStartPayload } from '@atlas/contracts';

import { childEnvironment } from '../git-environment.js';

export { childEnvironment };

const run = promisify(execFile);
const succeeds = (promise: Promise<unknown>) =>
  promise.then(
    () => true,
    () => false,
  );

export interface Worktree {
  path: string;
  branch: string;
  // Absolute `git rev-parse --absolute-git-dir` of the worktree.
  gitDir: string;
  // Absolute Git common dir of the main checkout.
  commonDir: string;
  // The folder the agent's Git writes objects to, so the project's own objects stay read-only.
  objectDir: string;
}

// The task id reduced to characters that are safe in folder, file and branch names.
export function sessionKey(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9-]/g, '') || 'task';
}

async function requireRealDirectory(path: string, label: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error(`${label} must be a real directory, not a link`);
  }
}

// A task folder is reused across sessions, and an earlier agent could have changed it. Before Git
// runs there, check that it still belongs to the project repository: a redirected worktree would
// make Git load config and hooks of the agent's choosing.
async function requireLinkedWorktree(path: string, commonDir: string) {
  const pointer = await readFile(join(path, '.git'), 'utf8').catch(() => null);
  // Like Git, drop only the line ending: a leading space is part of the path.
  const line = (text: string) => text.replace(/[\r\n]+$/, '');
  const target = pointer === null ? undefined : /^gitdir: (.+)$/.exec(line(pointer))?.[1];
  if (target === undefined) {
    throw new Error(`The task folder exists but is not a Git worktree: ${path}`);
  }
  const linked = await (async () => {
    const common = await realpath(commonDir);
    const gitDir = await realpath(resolve(path, target));
    const read = async (name: string) => line(await readFile(join(gitDir, name), 'utf8'));
    return (
      gitDir.startsWith(join(common, 'worktrees') + sep) &&
      (await realpath(resolve(gitDir, await read('commondir')))) === common &&
      // The Git folder must name this task folder, not another task's.
      (await realpath(resolve(gitDir, await read('gitdir')))) === join(await realpath(path), '.git')
    );
  })().catch(() => false);
  if (!linked) {
    throw new Error(
      `The task folder's Git links no longer point at the project repository, so it was not used: ${path}`,
    );
  }
}

export async function ensureWorktree(
  root: string,
  repository: string,
  payload: SessionStartPayload,
): Promise<Worktree> {
  const git = async (cwd: string, args: string[]) =>
    (await run('git', args, { cwd, timeout: 30_000, env: childEnvironment(root) })).stdout.trim();
  const isTopLevel = async (directory: string) =>
    (await git(directory, ['rev-parse', '--show-toplevel']).catch(() => null)) === directory;

  await requireRealDirectory(repository, 'The project folder');
  if (!(await isTopLevel(repository))) {
    throw new Error('The project folder is not its own Git repository');
  }
  if (!(await succeeds(git(repository, ['rev-parse', '--verify', '--quiet', 'HEAD'])))) {
    // A worktree needs a commit to branch from; Atlas-initialized repositories start empty.
    // Build an empty root commit directly so the user's index and hooks are left alone.
    const tree = await git(repository, ['hash-object', '-w', '-t', 'tree', '/dev/null']);
    const commit = await git(repository, [
      '-c',
      'user.name=Atlas',
      '-c',
      'user.email=atlas@localhost',
      'commit-tree',
      tree,
      '-m',
      'chore: initial commit',
    ]);
    await git(repository, ['update-ref', 'HEAD', commit]);
  }

  const base = resolve(root, '.atlas-worktrees');
  // Encoding keeps nested project paths such as "a/b" distinct from a project named "a__b".
  const projectDirectory = resolve(base, encodeURIComponent(payload.relativePath));
  await mkdir(projectDirectory, { recursive: true });
  await requireRealDirectory(base, 'The worktree folder');
  await requireRealDirectory(projectDirectory, 'The project worktree folder');

  const commonDir = await git(repository, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const describe = async (path: string, branch: string): Promise<Worktree> => {
    const gitDir = await git(path, ['rev-parse', '--absolute-git-dir']);
    const objectDir = join(gitDir, 'objects');
    // Git refuses to run with an object folder that does not exist.
    await mkdir(objectDir, { recursive: true });
    return { path, branch, gitDir, commonDir, objectDir };
  };
  const reuse = async (path: string, branch: string) => {
    if (!(await succeeds(stat(path)))) return null;
    await requireLinkedWorktree(path, commonDir);
    if (!(await isTopLevel(path))) {
      throw new Error(`The task folder exists but is not a Git worktree: ${path}`);
    }
    return describe(path, branch);
  };
  const key = sessionKey(payload.sessionId);
  const branch = `atlas/task-${key}`;
  const path = resolve(projectDirectory, key);
  // Worktrees made before task folders used the full task id keep working.
  const shortKey = key.replaceAll('-', '').slice(0, 8);
  const existing =
    (await reuse(path, branch)) ??
    (await reuse(
      resolve(base, payload.relativePath.replaceAll('/', '__'), shortKey),
      `atlas/task-${shortKey}`,
    ));
  if (existing) return existing;

  // Forget worktrees whose folders were deleted by hand, so the branch can be checked out again.
  await git(repository, ['worktree', 'prune']);
  const exists = await succeeds(
    git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]),
  );
  await git(
    repository,
    exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path],
  );
  return describe(path, branch);
}
