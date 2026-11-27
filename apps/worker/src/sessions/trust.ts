import { lstat, open } from 'node:fs/promises';

const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Claude asks once per folder whether to trust it; the record answers that for a task worktree.
// The file is rewritten in place, never replaced, so a bind-mounted file keeps working.
// Returns whether the record is now present. Nothing from the file is logged.
export async function trustWorktree(configPath: string, worktreePath: string): Promise<boolean> {
  try {
    const info = await lstat(configPath);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return false;
    const handle = await open(configPath, 'r+');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES) return false;
      const config: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!isObject(config)) return false;
      const projects = isObject(config.projects) ? config.projects : {};
      const project = isObject(projects[worktreePath]) ? projects[worktreePath] : {};
      projects[worktreePath] = { ...project, hasTrustDialogAccepted: true };
      config.projects = projects;
      const text = JSON.stringify(config, null, 2);
      await handle.truncate(0);
      await handle.write(text, 0, 'utf8');
      await handle.sync();
      const buffer = Buffer.alloc(Buffer.byteLength(text, 'utf8') + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const back: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      return confirmed(back, worktreePath);
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
