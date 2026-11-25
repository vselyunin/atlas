import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { childEnvironment } from './worktree.js';
import type { Worktree } from './worktree.js';

// An agent writes Git objects only to a folder of its own and reads the project's object store
// through Git's alternates. The Worker copies the task branch's new objects into the project's
// store. Git names every copied object by its content again, so an agent cannot put changed
// content under the name of an object the project already has or will create.

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;
const MAX_LIST_BYTES = 256 * 1024 * 1024;
// Everything the project already has, apart from task branches: their tips may not be copied yet.
const PROJECT_REFS = ['--exclude=atlas/*', '--branches', '--tags', '--remotes'];
// The agent writes the packs in its folder. Git reads them here outside the sandbox, so the
// optional index formats it would also read from that folder are turned off.
const CAREFUL = [
  '-c',
  'core.commitGraph=false',
  '-c',
  'core.multiPackIndex=false',
  '-c',
  'pack.useBitmaps=false',
  '-c',
  'pack.allowPackReuse=false',
];
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NO_COMMIT = 'the task branch does not point at a commit';

// One entry of GIT_ALTERNATE_OBJECT_DIRECTORIES. Git splits the value on colons and reads an entry
// that starts with a double quote as a C-style quoted string.
export function alternatesEntry(path: string): string {
  if (!path.includes(':') && !path.startsWith('"')) return path;
  return `"${path.replace(/[\\"]/g, '\\$&').replaceAll('\n', '\\n')}"`;
}

// What the agent's Git needs to write objects to its own folder and read the project's.
export function agentObjectEnvironment(worktree: Worktree): Record<string, string> {
  return {
    GIT_OBJECT_DIRECTORY: worktree.objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesEntry(join(worktree.commonDir, 'objects')),
  };
}

function firstLine(error: unknown): string {
  const details = error as { stderr?: unknown; message?: unknown };
  const text = [details.stderr, details.message].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  return text?.trim().split('\n')[0] ?? String(error);
}

// The commit the task branch points at, read without Git. The agent can write the branch file, so
// it is read as data only: never through a link, never waiting on a pipe, and only when small.
export async function readTaskTip(worktree: Worktree): Promise<string> {
  const refName = `refs/heads/${worktree.branch}`;
  const file = await open(
    join(worktree.commonDir, ...refName.split('/')),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw new Error(NO_COMMIT, { cause: error });
  });
  if (file !== null) {
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 100) throw new Error(NO_COMMIT);
      const text = (await file.readFile('utf8')).trim();
      if (!OBJECT_ID.test(text)) throw new Error(NO_COMMIT);
      return text;
    } finally {
      await file.close();
    }
  }
  // Git may have packed the branch; the agent cannot write that file.
  const packed = await readFile(join(worktree.commonDir, 'packed-refs'), 'utf8').catch(() => '');
  for (const line of packed.split('\n')) {
    const [id = '', name] = line.split(' ');
    if (name === refName && OBJECT_ID.test(id)) return id;
  }
  throw new Error(NO_COMMIT);
}

// Packs the listed objects with the agent's folder visible and unpacks them into the project's
// store without it.
function copyObjects(
  commonDir: string,
  list: string,
  env: NodeJS.ProcessEnv,
  agentEnv: NodeJS.ProcessEnv,
) {
  return new Promise<void>((resolve, reject) => {
    const pack = spawn(
      'git',
      [...CAREFUL, '--git-dir', commonDir, 'pack-objects', '--stdout', '-q'],
      { timeout: TIMEOUT_MS, env: agentEnv, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // `--strict` also checks each object's format before it is stored.
    const unpack = spawn('git', ['--git-dir', commonDir, 'unpack-objects', '-q', '--strict'], {
      timeout: TIMEOUT_MS,
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const errors = { pack: '', unpack: '' };
    pack.stderr.on('data', (data: Buffer) => (errors.pack += data.toString()));
    unpack.stderr.on('data', (data: Buffer) => (errors.unpack += data.toString()));
    const codes: Record<string, number | null> = {};
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      pack.kill();
      unpack.kill();
      reject(error);
    };
    const closed = (name: 'pack' | 'unpack', code: number | null) => {
      codes[name] = code;
      if (code !== 0) {
        const reason = errors[name].trim().split('\n')[0];
        return fail(new Error(reason || `git ${name}-objects did not finish`));
      }
      if (codes.pack === 0 && codes.unpack === 0) resolve();
    };
    pack.on('error', fail);
    unpack.on('error', fail);
    pack.on('close', (code) => closed('pack', code));
    unpack.on('close', (code) => closed('unpack', code));
    // A process that exits early closes its pipe; its exit code reports the failure.
    pack.stdin.on('error', () => {});
    unpack.stdin.on('error', () => {});
    pack.stdout.pipe(unpack.stdin);
    pack.stdin.end(list);
  });
}

// Copies the objects of the task branch that the project's store lacks, then checks that the
// branch is complete there. Returns the branch tip. `known` is a tip an earlier call returned.
export async function importTaskObjects(
  root: string,
  worktree: Worktree,
  known?: string,
): Promise<string> {
  const env = childEnvironment(root);
  const agentEnv = {
    ...env,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesEntry(worktree.objectDir),
  };
  const git = async (args: string[], gitEnv: NodeJS.ProcessEnv) =>
    (
      await run('git', [...CAREFUL, '--git-dir', worktree.commonDir, ...args], {
        env: gitEnv,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_LIST_BYTES,
      })
    ).stdout;

  const tip = await readTaskTip(worktree);
  if (tip === known) return tip;
  // A branch must name a commit itself, not a tag that leads to one.
  const commit = await git(['rev-parse', '--verify', '--quiet', `${tip}^{commit}`], agentEnv).catch(
    () => '',
  );
  if (commit.trim() !== tip) throw new Error(NO_COMMIT);
  try {
    const missing = [tip, '--not', ...(known === undefined ? [] : [known]), ...PROJECT_REFS];
    const list = await git(['rev-list', '--objects', ...missing], agentEnv);
    if (list.trim() !== '') await copyObjects(worktree.commonDir, list, env, agentEnv);
    // Without the agent's folder: everything the branch needs must now be in the project's store.
    await git(['rev-list', '--objects', '--quiet', tip, '--not', ...PROJECT_REFS], env);
  } catch (error) {
    throw new Error(firstLine(error), { cause: error });
  }
  return tip;
}

export const IMPORT_FAILED = "The agent's commits could not be copied into the project repository";

// Keeps the project's store up to date while a session runs: copies at once, again whenever the
// task branch moves, and a last time when the session ends.
export function startObjectSync(root: string, worktree: Worktree, intervalMs: number) {
  let known: string | undefined;
  let seen: string | undefined;
  let checking = false;
  let last: Promise<string | null> = Promise.resolve(null);
  // One copy at a time. Resolves to the failure, or null when the branch is complete.
  const copy = () => {
    last = last.then(async () => {
      try {
        known = await importTaskObjects(root, worktree, known);
        return null;
      } catch (error) {
        return `${IMPORT_FAILED}: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    return last;
  };
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const value = await readTaskTip(worktree).catch(() => 'unreadable');
      if (value === seen) return;
      seen = value;
      await copy();
    } finally {
      checking = false;
    }
  };
  void check();
  const timer = setInterval(() => void check(), intervalMs);
  timer.unref();
  return {
    // Stops watching and makes the last copy, giving up on it after the deadline.
    finish(deadlineMs = 60_000): Promise<string | null> {
      clearInterval(timer);
      let deadline: NodeJS.Timeout | undefined;
      const late = new Promise<string>((resolve) => {
        deadline = setTimeout(() => resolve(`${IMPORT_FAILED}: it took too long`), deadlineMs);
      });
      return Promise.race([copy(), late]).finally(() => clearTimeout(deadline));
    },
  };
}
