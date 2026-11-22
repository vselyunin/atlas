import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SessionStartPayload } from '@atlas/contracts';

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
}

export function childEnvironment(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Git hooks and the agent must not inherit the Worker token or other Atlas settings.
    if (value !== undefined && !name.startsWith('ATLAS_')) env[name] = value;
  }
  // Git must never fall through to a repository above the workspace, such as the Atlas checkout.
  env.GIT_CEILING_DIRECTORIES = root;
  return env;
}

async function requireRealDirectory(path: string, label: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error(`${label} must be a real directory, not a link`);
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

  const describe = async (path: string, branch: string): Promise<Worktree> => ({
    path,
    branch,
    gitDir: await git(path, ['rev-parse', '--absolute-git-dir']),
    commonDir: await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  });
  const reuse = async (path: string, branch: string) => {
    if (!(await succeeds(stat(path)))) return null;
    if (!(await isTopLevel(path))) {
      throw new Error(`The task folder exists but is not a Git worktree: ${path}`);
    }
    return describe(path, branch);
  };
  const key = payload.sessionId.replace(/[^a-zA-Z0-9-]/g, '') || 'task';
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
