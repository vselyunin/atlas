import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// What the Worker remembers about a session's agent run, keyed by the session key.
export interface RunRecord {
  agentSessionId: string;
  delivered: boolean;
}

export type RunMode = 'first' | 'resume' | 'fresh';

export const RUN_NOTICES: Record<RunMode, string> = {
  first: 'Atlas: first run, the task prompt was sent.\r\n',
  resume: 'Atlas: resumed the earlier conversation; the task prompt was not sent again.\r\n',
  fresh: 'Atlas: the earlier conversation is gone; started without the task prompt.\r\n',
};

const MAX_RECORD_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recordsDirectory(stateDir: string): string {
  return join(stateDir, 'session-records');
}

function recordPath(stateDir: string, key: string): string {
  return join(recordsDirectory(stateDir), `${key}.json`);
}

export async function readRecord(stateDir: string, key: string): Promise<RunRecord | null> {
  try {
    const path = recordPath(stateDir, key);
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
    const handle = await open(path, 'r');
    let text: string;
    try {
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_RECORD_BYTES) return null;
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const { agentSessionId, delivered } = value as Record<string, unknown>;
    if (typeof agentSessionId !== 'string' || !UUID.test(agentSessionId)) return null;
    if (typeof delivered !== 'boolean') return null;
    return { agentSessionId, delivered };
  } catch {
    return null;
  }
}

export async function writeRecord(stateDir: string, key: string, record: RunRecord): Promise<void> {
  const directory = recordsDirectory(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = recordPath(stateDir, key);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// Claude keeps a conversation at `<home>/.claude/projects/<project>/<id>.jsonl`.
export async function conversationExists(home: string, agentSessionId: string): Promise<boolean> {
  const projects = join(home, '.claude', 'projects');
  let names: string[];
  try {
    names = await readdir(projects);
  } catch {
    return false;
  }
  for (const name of names) {
    try {
      const info = await lstat(join(projects, name, `${agentSessionId}.jsonl`));
      if (info.isFile()) return true;
    } catch {
      // Not in this project folder.
    }
  }
  return false;
}

export function chooseRun(record: RunRecord | null, hasConversation: boolean): RunMode {
  if (hasConversation) return 'resume';
  return record?.delivered ? 'fresh' : 'first';
}
