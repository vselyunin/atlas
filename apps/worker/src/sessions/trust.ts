import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readAll(handle: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  return buffer.subarray(0, bytesRead);
}

// Claude asks once per folder whether to trust it; the record answers that for a task worktree.
// The file is rewritten in place, never replaced, so a bind-mounted file keeps working.
// The new body is written first and the file cut to its length afterwards. A failure restores
// the original bytes on a best-effort basis; a crash in the middle of a write cannot be undone
// without a rename, which is not allowed here.
// Returns whether the record is now present. Nothing from the file is logged.
export async function trustWorktree(configPath: string, worktreePath: string): Promise<boolean> {
  try {
    const info = await lstat(configPath);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return false;
    const handle = await open(configPath, 'r+');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES) return false;
      const original = await readAll(handle, opened.size);
      const config: unknown = JSON.parse(original.toString('utf8'));
      if (!isObject(config)) return false;
      const projects = isObject(config.projects) ? config.projects : {};
      const project = isObject(projects[worktreePath]) ? projects[worktreePath] : {};
      projects[worktreePath] = { ...project, hasTrustDialogAccepted: true };
      config.projects = projects;
      const body = Buffer.from(JSON.stringify(config, null, 2), 'utf8');
      try {
        await handle.write(body, 0, body.length, 0);
        await handle.truncate(body.length);
        await handle.sync();
        const back: unknown = JSON.parse((await readAll(handle, body.length)).toString('utf8'));
        if (confirmed(back, worktreePath)) return true;
      } catch {
        // Fall through to the restore.
      }
      try {
        await handle.write(original, 0, original.length, 0);
        await handle.truncate(original.length);
        await handle.sync();
      } catch {
        // Nothing more can be done.
      }
      return false;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

function confirmed(config: unknown, worktreePath: string): boolean {
  if (!isObject(config) || !isObject(config.projects)) return false;
  const project = config.projects[worktreePath];
  return isObject(project) && project.hasTrustDialogAccepted === true;
}
