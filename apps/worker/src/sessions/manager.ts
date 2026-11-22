import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import { MAX_SESSION_OUTPUT_CHARS } from '@atlas/contracts';
import type {
  SessionExit,
  SessionOutput,
  SessionStartPayload,
  SessionStarted,
  TerminalSize,
} from '@atlas/contracts';
import { resolveTarget } from '../repositories/paths.js';
import type { WorkerConfig } from '../config.js';

// Spike: one terminal session per task, each in its own Git worktree. Nothing survives a restart.

const run = promisify(execFile);
const succeeds = (promise: Promise<unknown>) =>
  promise.then(
    () => true,
    () => false,
  );

export type SessionEvent =
  | Pick<SessionStarted, 'type' | 'payload'>
  | Pick<SessionOutput, 'type' | 'payload'>
  | Pick<SessionExit, 'type' | 'payload'>;

interface Session {
  terminal: IPty;
  path: string;
  branch: string;
  // The API's id for its current view of this session; replaced when the API attaches again.
  runId: string;
  killTimer?: NodeJS.Timeout;
}

interface PendingStart {
  runId: string;
  cancelled: boolean;
}

function childEnvironment(root: string): Record<string, string> {
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

async function ensureWorktree(root: string, repository: string, payload: SessionStartPayload) {
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

  const reuse = async (path: string, branch: string) => {
    if (!(await succeeds(stat(path)))) return null;
    if (!(await isTopLevel(path))) {
      throw new Error(`The task folder exists but is not a Git worktree: ${path}`);
    }
    return { path, branch };
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
  return { path, branch };
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingStart>();
  private readonly root: string;
  private readonly command: string[];
  private readonly stopGraceMs: number;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    config: WorkerConfig,
    private readonly emit: (event: SessionEvent) => void,
    options: { stopGraceMs?: number } = {},
  ) {
    this.root = config.root;
    this.command = config.agent.command;
    this.stopGraceMs = options.stopGraceMs ?? 5_000;
  }

  start(payload: SessionStartPayload): Promise<void> {
    const { sessionId, runId } = payload;
    const running = this.sessions.get(sessionId);
    if (running) {
      // The API forgot this session, for example after its own restart; let it attach again.
      running.runId = runId;
      this.emit({
        type: 'session.started',
        payload: { sessionId, runId, worktreePath: running.path, branch: running.branch },
      });
      return Promise.resolve();
    }
    if (this.stopped || this.pending.has(sessionId)) return Promise.resolve();
    const pending: PendingStart = { runId, cancelled: false };
    this.pending.set(sessionId, pending);
    // One start at a time, so two tasks cannot race while preparing the same repository.
    this.queue = this.queue.then(() => this.launch(payload, pending));
    return this.queue;
  }

  private async launch(payload: SessionStartPayload, pending: PendingStart): Promise<void> {
    const { sessionId, runId } = payload;
    const exit = (message: string) =>
      this.emit({ type: 'session.exit', payload: { sessionId, runId, exitCode: null, message } });
    try {
      const abandoned = () => this.stopped || pending.cancelled;
      if (abandoned()) return exit('The session was stopped before it started');
      const repository = await resolveTarget(this.root, payload.relativePath);
      const { path, branch } = await ensureWorktree(this.root, repository, payload);
      if (abandoned()) return exit('The session was stopped before it started');
      const [file = 'claude', ...args] = this.command;
      if (payload.prompt && ['claude', 'codex'].includes(basename(file))) {
        // A leading dash would be read as a command-line option of the agent.
        args.push(payload.prompt.startsWith('-') ? ` ${payload.prompt}` : payload.prompt);
      }
      const terminal = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: payload.cols,
        rows: payload.rows,
        cwd: path,
        env: childEnvironment(this.root),
      });
      const session: Session = { terminal, path, branch, runId };
      this.sessions.set(sessionId, session);
      this.emit({
        type: 'session.started',
        payload: { sessionId, runId, worktreePath: path, branch },
      });
      terminal.onData((data) => {
        for (let offset = 0; offset < data.length; offset += MAX_SESSION_OUTPUT_CHARS) {
          this.emit({
            type: 'session.output',
            payload: {
              sessionId,
              runId: session.runId,
              data: data.slice(offset, offset + MAX_SESSION_OUTPUT_CHARS),
            },
          });
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(session.killTimer);
        if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
        this.emit({
          type: 'session.exit',
          payload: { sessionId, runId: session.runId, exitCode, message: null },
        });
      });
    } catch (error) {
      exit(error instanceof Error ? error.message : 'Could not start the session');
    } finally {
      this.pending.delete(sessionId);
    }
  }

  input(sessionId: string, runId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.terminal.write(data);
    else if (!this.pending.has(sessionId)) this.reportMissing(sessionId, runId);
  }

  resize(sessionId: string, { cols, rows }: TerminalSize): void {
    this.sessions.get(sessionId)?.terminal.resize(cols, rows);
  }

  stop(sessionId: string, runId: string): void {
    const session = this.sessions.get(sessionId);
    const pending = this.pending.get(sessionId);
    if (session) this.kill(session);
    else if (pending) pending.cancelled = true;
    else this.reportMissing(sessionId, runId);
  }

  stopAll(): void {
    this.stopped = true;
    for (const pending of this.pending.values()) pending.cancelled = true;
    for (const session of this.sessions.values()) this.kill(session);
  }

  private kill(session: Session) {
    session.terminal.kill();
    // An agent that ignores the hangup is killed outright after a grace period.
    session.killTimer ??= setTimeout(() => {
      try {
        session.terminal.kill('SIGKILL');
      } catch {
        // The process already exited.
      }
    }, this.stopGraceMs);
    session.killTimer.unref();
  }

  private reportMissing(sessionId: string, runId: string) {
    this.emit({
      type: 'session.exit',
      payload: { sessionId, runId, exitCode: null, message: 'The session is no longer running' },
    });
  }
}
