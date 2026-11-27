import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ChangeMode = (path: string, mode: number) => Promise<void>;

/** The outcome code of a command refused because the workspace cannot hold a Git repository. */
export const WORKSPACE_PERMISSIONS_CODE = 'workspace_permissions';

/**
 * Git changes the mode of its configuration lock file whenever it writes a repository's
 * configuration, so `git init`, `git remote add` and a tracking checkout fail where the Worker's
 * user may not do that. A Windows drive mounted in WSL without the `metadata` option is such a
 * place for every user except the one the mount names as owner.
 */
export const workspacePermissionsMessage = (root: string) =>
  `The Worker cannot change file permissions in the workspace ${root}, and Git needs that to ` +
  'create a repository. This is usual for a workspace on a Windows drive under WSL. See ' +
  '"Workspace on a Windows drive" in docs/development/local-setup.md.';

/**
 * Whether the Worker's user may change the mode of a folder it has just made. The mode is set to
 * what it already is, so nothing changes where this is allowed.
 */
export async function canChangeMode(
  directory: string,
  change: ChangeMode = chmod,
): Promise<boolean> {
  const info = await lstat(directory);
  try {
    await change(directory, info.mode & 0o7777);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return false;
    throw error;
  }
}

/**
 * Checks the workspace once with a short-lived folder of its own, whose dot name no project can
 * have. Returns the message to show when repositories cannot be created there, otherwise null.
 * A workspace that cannot be checked at all is left to the commands to report.
 */
export async function workspaceProblem(
  root: string,
  change: ChangeMode = chmod,
): Promise<string | null> {
  const probe = join(root, `.atlas-probe-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(probe);
  } catch {
    return null;
  }
  try {
    return (await canChangeMode(probe, change)) ? null : workspacePermissionsMessage(root);
  } catch {
    return null;
  } finally {
    await rmdir(probe).catch(() => undefined);
  }
}
