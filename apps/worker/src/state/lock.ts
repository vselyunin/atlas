import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Tokens of the locks this process holds. A container Worker gets the same PID on every start,
// so the PID alone cannot tell a live lock from one left behind by a killed container.
const heldTokens = new Set<string>();

function parseLock(content: string): { pid: number; token: string | undefined } | undefined {
  const match = /^(\d+)(?: ([0-9a-f-]+))?$/.exec(content.trim());
  if (!match?.[1]) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, token: match[2] };
}

export function acquireLock(stateDir: string): () => void {
  const path = join(stateDir, 'worker.lock');
  const token = randomUUID();
  const content = `${process.pid} ${token}`;
  try {
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const lock = parseLock(readFileSync(path, 'utf8'));
    if (!lock)
      throw new Error('Invalid Worker lock; inspect it before removing it', { cause: error });
    // Known limits: `process.kill(pid, 0)` cannot see across PID namespaces. A natively started
    // Worker and a containerized Worker pointed at the same state directory can therefore each
    // treat the other's live lock as stale and take it over. Two containers sharing a state
    // directory get the same PID, so the token rule below lets them take over each other's lock
    // too. Do not point two Workers at one state directory.
    let alive: boolean;
    if (lock.pid === process.pid) {
      alive = lock.token !== undefined && heldTokens.has(lock.token);
    } else {
      alive = true;
      try {
        process.kill(lock.pid, 0);
      } catch (probe) {
        if (probe instanceof Error && 'code' in probe && probe.code === 'ESRCH') alive = false;
      }
    }
    if (alive) throw new Error('Another Worker is using this state directory', { cause: error });
    unlinkSync(path);
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
  }
  heldTokens.add(token);
  return () => {
    heldTokens.delete(token);
    try {
      if (readFileSync(path, 'utf8') === content) unlinkSync(path);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  };
}
