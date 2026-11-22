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
const git = (cwd: string, args: string[]) => run('git', args, { cwd, timeout: 30_000 });
const succeeds = (promise: Promise<unknown>) =>
  promise.then(
    () => true,
    () => false,
  );

export type SessionEvent =
  | Pick<SessionStarted, 'type' | 'payload'>
  | Pick<SessionOutput, 'type' | 'payload'>
  | Pick<SessionExit, 'type' | 'payload'>;

async function ensureWorktree(root: string, repository: string, payload: SessionStartPayload) {
  if (!(await succeeds(git(repository, ['rev-parse', '--verify', '--quiet', 'HEAD'])))) {
    // A worktree needs a commit to branch from; Atlas-initialized repositories start empty.
    await git(repository, [
      '-c',
      'user.name=Atlas',
      '-c',
      'user.email=atlas@localhost',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'chore: initial commit',
    ]);
  }
  const key = payload.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'task';
  const branch = `atlas/task-${key}`;
  const path = resolve(root, '.atlas-worktrees', payload.relativePath.replaceAll('/', '__'), key);
  if (await succeeds(stat(path))) return { path, branch };
  await mkdir(dirname(path), { recursive: true });
  const exists = await succeeds(
    git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]),
  );
  await git(
    repository,
    exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path],
  );
  return { path, branch };
}

function agentEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // The agent must not inherit the Worker token or other Atlas settings.
    if (value !== undefined && !name.startsWith('ATLAS_')) env[name] = value;
  }
  return env;
}

export class SessionManager {
  private readonly sessions = new Map<string, IPty>();
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
    if (this.sessions.has(sessionId) || this.starting.has(sessionId)) return;
    this.starting.add(sessionId);
    try {
      const repository = await resolveTarget(this.root, payload.relativePath);
      const { path, branch } = await ensureWorktree(this.root, repository, payload);
      const [file = 'claude', ...args] = this.command;
      if (payload.prompt && ['claude', 'codex'].includes(basename(file))) args.push(payload.prompt);
      const terminal = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: payload.cols,
        rows: payload.rows,
        cwd: path,
        env: agentEnvironment(),
      });
      this.sessions.set(sessionId, terminal);
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
        if (this.sessions.get(sessionId) === terminal) this.sessions.delete(sessionId);
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
    const terminal = this.sessions.get(sessionId);
    if (terminal) terminal.write(data);
    else if (!this.starting.has(sessionId)) this.reportMissing(sessionId);
  }

  resize(sessionId: string, { cols, rows }: TerminalSize): void {
    this.sessions.get(sessionId)?.resize(cols, rows);
  }

  stop(sessionId: string): void {
    const terminal = this.sessions.get(sessionId);
    if (terminal) terminal.kill();
    else if (!this.starting.has(sessionId)) this.reportMissing(sessionId);
  }

  stopAll(): void {
    for (const terminal of this.sessions.values()) terminal.kill();
    this.sessions.clear();
  }

  private reportMissing(sessionId: string) {
    this.emit({
      type: 'session.exit',
      payload: { sessionId, exitCode: null, message: 'The session is no longer running' },
    });
  }
}
