import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
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
import { agentArgs, agentProfile } from './agents.js';
import {
  SANDBOX_OFF_NOTICE,
  SANDBOX_ON_NOTICE,
  agentEnvironment,
  prepareSandbox,
  sandboxSettings,
  writeExcludesFile,
} from './sandbox.js';
import { ensureWorktree, sessionKey } from './worktree.js';
import type { AgentSettings, WorkerConfig } from '../config.js';

// Spike: one terminal session per task, each in its own Git worktree. Nothing survives a restart.

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

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingStart>();
  private readonly root: string;
  private readonly stateDir: string;
  private readonly agent: AgentSettings;
  private readonly stopGraceMs: number;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private excludes: Promise<string> | undefined;

  constructor(
    config: WorkerConfig,
    private readonly emit: (event: SessionEvent) => void,
    options: { stopGraceMs?: number } = {},
  ) {
    this.root = config.root;
    this.stateDir = config.stateDir;
    this.agent = config.agent;
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
    const stoppedEarly = 'The session was stopped before it started';
    try {
      const abandoned = () => this.stopped || pending.cancelled;
      if (abandoned()) return exit(stoppedEarly);
      const repository = await resolveTarget(this.root, payload.relativePath);
      const worktree = await ensureWorktree(this.root, repository, payload);
      const { path, branch } = worktree;
      if (abandoned()) return exit(stoppedEarly);
      const env = agentEnvironment(this.root, this.agent, await this.excludesFile());
      if (abandoned()) return exit(stoppedEarly);
      const sandboxed = this.agent.sandbox === 'required';
      const [agentFile = 'claude'] = this.agent.command;
      const profile = agentProfile(this.agent.command);
      const args = agentArgs(profile, this.agent.command, payload.prompt, sandboxed);
      let file = agentFile;
      if (sandboxed) {
        const home = homedir();
        const { settingsPath } = await prepareSandbox({
          sessionKey: sessionKey(sessionId),
          settings: sandboxSettings({
            worktree,
            stateDir: this.stateDir,
            home,
            profile,
            allowedDomains: this.agent.allowedDomains,
          }),
          stateDir: this.stateDir,
          cwd: path,
          env,
          writableDirectories: profile.writableDirectories(home),
        });
        if (abandoned()) return exit(stoppedEarly);
        // The agent and its arguments stay separate arguments, so no shell reads the prompt.
        // `--` stops srt reading the agent's options as its own.
        file = 'srt';
        args.unshift('--settings', settingsPath, '--', agentFile);
      }
      const terminal = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: payload.cols,
        rows: payload.rows,
        cwd: path,
        env,
      });
      const session: Session = { terminal, path, branch, runId };
      this.sessions.set(sessionId, session);
      this.emit({
        type: 'session.started',
        payload: { sessionId, runId, worktreePath: path, branch },
      });
      // Said before any agent output, so the user always knows whether the sandbox is on.
      this.emit({
        type: 'session.output',
        payload: { sessionId, runId, data: sandboxed ? SANDBOX_ON_NOTICE : SANDBOX_OFF_NOTICE },
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
    // Nothing starts after this, so the excludes file can go with the Worker.
    void this.excludes
      ?.then((path) => rm(dirname(path), { recursive: true, force: true }))
      .catch(() => {});
  }

  // Written once per manager, outside the Worker state directory the agent cannot read.
  private excludesFile(): Promise<string> {
    this.excludes ??= writeExcludesFile().catch((error: unknown) => {
      this.excludes = undefined;
      throw error;
    });
    return this.excludes;
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
