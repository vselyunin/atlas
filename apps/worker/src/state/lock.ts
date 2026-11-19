import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function acquireLock(stateDir: string): () => void {
  const path = join(stateDir, 'worker.lock');
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Invalid Worker lock; inspect it before removing it', { cause: error });
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (probe) {
      if (probe instanceof Error && 'code' in probe && probe.code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('Another Worker is using this state directory', { cause: error });
    unlinkSync(path);
    writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  return () => {
    try {
      if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  };
}
