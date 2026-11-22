import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
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

async function ensureWorktree(root: string, repository: string, payload: SessionStartPayload) {
  const git = async (cwd: string, args: string[]) =>
    (await run('git', args, { cwd, timeout: 30_000, env: childEnvironment(root) })).stdout.trim();
  const isTopLevel = async (directory: string) =>
    (await git(directory, ['rev-parse', '--show-toplevel']).catch(() => null)) === directory;

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
  const key = payload.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'task';
  const branch = `atlas/task-${key}`;
  const path = resolve(root, '.atlas-worktrees', payload.relativePath.replaceAll('/', '__'), key);
  if (await succeeds(stat(path))) {
    if (!(await isTopLevel(path))) {
      throw new Error(`The task folder exists but is not a Git worktree: ${path}`);
    }
    return { path, branch };
  }
  await mkdir(dirname(path), { recursive: true });
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
  private readonly starting = new Set<string>();
  private readonly command: string[];

  constructor(
    private readonly root: string,
    private readonly emit: (event: SessionEvent) => void,
    command = process.env.ATLAS_AGENT_COMMAND ?? 'claude',
  ) {
    this.command = command.split(/\s+/).filter(Boolean);
  }

  async start(payload: SessionStartPayload): Promise<void> {
    const { sessionId } = payload;
    const running = this.sessions.get(sessionId);
    if (running) {
      // The API forgot this session, for example after its own restart; let it attach again.
      this.emit({
        type: 'session.started',
        payload: { sessionId, worktreePath: running.path, branch: running.branch },
      });
      return;
    }
    if (this.starting.has(sessionId)) return;
    this.starting.add(sessionId);
    try {
      const repository = await resolveTarget(this.root, payload.relativePath);
      const { path, branch } = await ensureWorktree(this.root, repository, payload);
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
      this.sessions.set(sessionId, { terminal, path, branch });
      this.emit({
        type: 'session.started',
        payload: { sessionId, worktreePath: path, branch },
      });
      terminal.onData((data) => {
        for (let offset = 0; offset < data.length; offset += MAX_SESSION_OUTPUT_CHARS) {
          this.emit({
            type: 'session.output',
            payload: { sessionId, data: data.slice(offset, offset + MAX_SESSION_OUTPUT_CHARS) },
          });
        }
      });
      terminal.onExit(({ exitCode }) => {
        if (this.sessions.get(sessionId)?.terminal === terminal) this.sessions.delete(sessionId);
        this.emit({ type: 'session.exit', payload: { sessionId, exitCode, message: null } });
      });
    } catch (error) {
      this.emit({
        type: 'session.exit',
        payload: {
          sessionId,
          exitCode: null,
          message: error instanceof Error ? error.message : 'Could not start the session',
        },
      });
    } finally {
      this.starting.delete(sessionId);
    }
  }

  input(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.terminal.write(data);
    else if (!this.starting.has(sessionId)) this.reportMissing(sessionId);
  }

  resize(sessionId: string, { cols, rows }: TerminalSize): void {
    this.sessions.get(sessionId)?.terminal.resize(cols, rows);
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.terminal.kill();
    else if (!this.starting.has(sessionId)) this.reportMissing(sessionId);
  }

  stopAll(): void {
    for (const session of this.sessions.values()) session.terminal.kill();
    this.sessions.clear();
  }

  private reportMissing(sessionId: string) {
    this.emit({
      type: 'session.exit',
      payload: { sessionId, exitCode: null, message: 'The session is no longer running' },
    });
  }
}
