import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import { MAX_SESSION_OUTPUT_CHARS } from '@atlas/contracts';
import type {
  SessionActivityMessage,
  SessionExit,
  SessionOutput,
  SessionStartPayload,
  SessionStarted,
  SessionSyncPayload,
  TerminalSize,
} from '@atlas/contracts';
import { resolveTarget } from '../repositories/paths.js';
import { agentProfile, sessionArgs } from './agents.js';
import { startObjectSync } from './objects.js';
import { RUN_NOTICES, chooseRun, conversationExists, readRecord, writeRecord } from './record.js';
import type { RunMode, RunRecord } from './record.js';
import {
  SANDBOX_OFF_NOTICE,
  SANDBOX_ON_NOTICE,
  agentEnvironment,
  prepareSandbox,
  sandboxSettings,
  writeExcludesFile,
} from './sandbox.js';
import { hookSettings, watchStatus, writeHookScript } from './status.js';
import type { AgentActivity } from './status.js';
import { trustWorktree } from './trust.js';
import { ensureWorktree, sessionKey } from './worktree.js';
import type { AgentSettings, WorkerConfig } from '../config.js';

// One terminal session per task, each in its own Git worktree. A later session of the task
// resumes the agent's conversation instead of sending the task prompt again.

export type SessionEvent =
  | Pick<SessionStarted, 'type' | 'payload'>
  | Pick<SessionOutput, 'type' | 'payload'>
  | Pick<SessionExit, 'type' | 'payload'>
  | Pick<SessionActivityMessage, 'type' | 'payload'>;

interface Session {
  terminal: IPty;
  path: string;
  branch: string;
  // The API's id for its current view of this session; replaced when the API attaches again.
  runId: string;
  killTimer?: NodeJS.Timeout;
  // Set by stop(), so the exit says the user ended the session.
  stopRequested: boolean;
  activity: AgentActivity | null;
  // The run the current activity was last reported to.
  activityRunId: string | null;
}

interface PendingStart {
  runId: string;
  cancelled: boolean;
}

// The folder a Claude run writes its status lines to, and the hook script that writes them.
interface StatusFolder {
  folder: string;
  file: string;
  // The value for `claude --settings` that adds the hooks.
  hookSettings: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingStart>();
  // Sessions whose agent has exited while the Worker still copies its last commits.
  private readonly finishing = new Map<string, Promise<void>>();
  private readonly root: string;
  private readonly stateDir: string;
  private readonly agent: AgentSettings;
  private readonly home: string;
  private readonly stopGraceMs: number;
  private readonly objectSyncMs: number;
  private readonly statusPollMs: number | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private excludes: Promise<string> | undefined;
  private statusBase: Promise<{ base: string; script: string }> | undefined;

  constructor(
    config: WorkerConfig,
    private readonly emit: (event: SessionEvent) => void,
    options: {
      stopGraceMs?: number;
      objectSyncMs?: number;
      home?: string;
      statusPollMs?: number;
    } = {},
  ) {
    this.root = config.root;
    this.stateDir = config.stateDir;
    this.agent = config.agent;
    this.home = options.home ?? homedir();
    this.stopGraceMs = options.stopGraceMs ?? 5_000;
    this.objectSyncMs = options.objectSyncMs ?? 2_000;
    this.statusPollMs = options.statusPollMs;
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
    // The earlier session of this task reports its exit first.
    const finishing = this.finishing.get(sessionId);
    if (finishing) return finishing.then(() => this.start(payload));
    if (this.stopped || this.pending.has(sessionId)) return Promise.resolve();
    const pending: PendingStart = { runId, cancelled: false };
    this.pending.set(sessionId, pending);
    // One start at a time, so two tasks cannot race while preparing the same repository.
    this.queue = this.queue.then(() => this.launch(payload, pending));
    return this.queue;
  }

  // Sessions running or still starting, for session.sync.
  snapshot(): SessionSyncPayload['sessions'] {
    const list: SessionSyncPayload['sessions'] = [];
    for (const [sessionId, { runId }] of this.pending) {
      if (this.sessions.has(sessionId)) continue;
      list.push({
        sessionId,
        runId,
        state: 'starting',
        worktreePath: null,
        branch: null,
        activity: null,
        detail: null,
      });
    }
    for (const [sessionId, session] of this.sessions) {
      list.push({
        sessionId,
        runId: session.runId,
        state: 'running',
        worktreePath: session.path,
        branch: session.branch,
        activity: session.activity?.activity ?? null,
        detail: session.activity?.detail ?? null,
      });
    }
    return list;
  }

  private async launch(payload: SessionStartPayload, pending: PendingStart): Promise<void> {
    const { sessionId, runId } = payload;
    const exit = (message: string) =>
      this.emit({ type: 'session.exit', payload: { sessionId, runId, exitCode: null, message } });
    const stoppedEarly = 'The session was stopped before it started';
    let status: StatusFolder | null = null;
    let spawned = false;
    try {
      const abandoned = () => this.stopped || pending.cancelled;
      if (abandoned()) return exit(stoppedEarly);
      const repository = await resolveTarget(this.root, payload.relativePath);
      const worktree = await ensureWorktree(this.root, repository, payload);
      const { path, branch } = worktree;
      if (abandoned()) return exit(stoppedEarly);
      const env = agentEnvironment(this.root, this.agent, await this.excludesFile(), worktree);
      if (abandoned()) return exit(stoppedEarly);
      const sandboxed = this.agent.sandbox === 'required';
      const [agentFile = 'claude'] = this.agent.command;
      const profile = agentProfile(this.agent.command);
      const isClaude = profile.kind === 'claude';
      const key = sessionKey(sessionId);
      const { mode, record } = await this.planRun(key, isClaude);
      if (isClaude) {
        status = await this.statusFolder(key);
        // Claude would ask whether to trust the new folder; inside the sandbox the Worker answers.
        if (sandboxed) await trustWorktree(join(this.home, '.claude.json'), path);
      }
      if (abandoned()) return exit(stoppedEarly);
      const args = sessionArgs({
        profile,
        command: this.agent.command,
        prompt: payload.prompt,
        sandboxed,
        mode,
        agentSessionId: record.agentSessionId,
        hookSettings: status?.hookSettings ?? null,
      });
      let file = agentFile;
      if (sandboxed) {
        const { settingsPath } = await prepareSandbox({
          sessionKey: key,
          settings: sandboxSettings({
            worktree,
            stateDir: this.stateDir,
            home: this.home,
            profile,
            allowedDomains: this.agent.allowedDomains,
            extraWritable: status === null ? [] : [status.folder],
          }),
          stateDir: this.stateDir,
          cwd: path,
          env,
          writableDirectories: profile.writableDirectories(this.home),
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
      spawned = true;
      const session: Session = {
        terminal,
        path,
        branch,
        runId,
        stopRequested: false,
        activity: null,
        activityRunId: null,
      };
      this.sessions.set(sessionId, session);
      // The agent's commits are in its own object folder until the Worker copies them.
      const objects = startObjectSync(this.root, worktree, this.objectSyncMs);
      this.emit({
        type: 'session.started',
        payload: { sessionId, runId, worktreePath: path, branch },
      });
      // Said before any agent output, so the user always knows whether the sandbox is on.
      this.emit({
        type: 'session.output',
        payload: { sessionId, runId, data: sandboxed ? SANDBOX_ON_NOTICE : SANDBOX_OFF_NOTICE },
      });
      this.emit({ type: 'session.output', payload: { sessionId, runId, data: RUN_NOTICES[mode] } });
      if (mode !== 'first')
        this.report(sessionId, session, { activity: 'idle', detail: 'resumed' });
      const runStatus = status;
      const watcher =
        runStatus === null
          ? null
          : watchStatus(
              runStatus.file,
              (activity) => this.report(sessionId, session, activity),
              this.statusPollMs,
            );
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
        watcher?.stop();
        if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
        // The exit is reported once the last commits are copied, so they can be used right away.
        const finished: Promise<void> = objects
          .finish()
          .then(async (message) => {
            await this.afterRun(key, record, runStatus, isClaude);
            this.emit({
              type: 'session.exit',
              payload: {
                sessionId,
                runId: session.runId,
                exitCode,
                message,
                ...(session.stopRequested ? { stopped: true } : {}),
              },
            });
          })
          .catch(() => {})
          .finally(() => {
            if (this.finishing.get(sessionId) === finished) this.finishing.delete(sessionId);
          });
        this.finishing.set(sessionId, finished);
      });
      // Codex and custom agents have no conversation to find: the prompt counts as delivered once
      // the process has started.
      if (!isClaude) {
        await writeRecord(this.stateDir, key, {
          agentSessionId: randomUUID(),
          delivered: true,
        }).catch(() => {});
      }
    } catch (error) {
      exit(error instanceof Error ? error.message : 'Could not start the session');
    } finally {
      // A run that never started leaves no status folder behind.
      if (status !== null && !spawned) await this.removeStatusFolder(status);
      this.pending.delete(sessionId);
    }
  }

  // Decides how this run starts and records the agent session id before the agent is spawned.
  private async planRun(
    key: string,
    isClaude: boolean,
  ): Promise<{ mode: RunMode; record: RunRecord }> {
    let record = await readRecord(this.stateDir, key);
    // Only Claude keeps conversations; for other agents the record alone decides.
    const hasConversation =
      isClaude && record !== null && (await conversationExists(this.home, record.agentSessionId));
    if (record !== null && !record.delivered && hasConversation) {
      record = { ...record, delivered: true };
      await writeRecord(this.stateDir, key, record);
    }
    const mode = chooseRun(record, hasConversation);
    if (mode === 'resume' && record !== null) return { mode, record };
    const fresh: RunRecord = { agentSessionId: randomUUID(), delivered: mode === 'fresh' };
    if (isClaude) await writeRecord(this.stateDir, key, fresh);
    return { mode, record: fresh };
  }

  // Never throws: the exit is reported whatever happens here.
  private async afterRun(
    key: string,
    record: RunRecord,
    status: StatusFolder | null,
    isClaude: boolean,
  ): Promise<void> {
    if (status !== null) await this.removeStatusFolder(status);
    if (!isClaude || record.delivered) return;
    try {
      if (await conversationExists(this.home, record.agentSessionId)) {
        await writeRecord(this.stateDir, key, { ...record, delivered: true });
      }
    } catch {
      // Checked again before the next start.
    }
  }

  private report(sessionId: string, session: Session, activity: AgentActivity) {
    const last = session.activity;
    if (
      session.activityRunId === session.runId &&
      last?.activity === activity.activity &&
      last.detail === activity.detail
    ) {
      return;
    }
    session.activity = activity;
    session.activityRunId = session.runId;
    this.emit({
      type: 'session.activity',
      payload: { sessionId, runId: session.runId, ...activity },
    });
  }

  // A new, empty status file for one run. Status is best effort: on any failure the agent
  // starts without hooks.
  private async statusFolder(key: string): Promise<StatusFolder | null> {
    try {
      this.statusBase ??= (async () => {
        // Outside the worktree and the Worker state directory; mkdtemp makes it private.
        const base = await mkdtemp(join(tmpdir(), 'atlas-status-'));
        return { base, script: await writeHookScript(base) };
      })().catch((error: unknown) => {
        this.statusBase = undefined;
        throw error;
      });
      const { base, script } = await this.statusBase;
      const folder = join(base, key);
      await rm(folder, { recursive: true, force: true });
      await mkdir(folder, { mode: 0o700 });
      const file = join(folder, 'status');
      await writeFile(file, '', { mode: 0o600, flag: 'wx' });
      return { folder, file, hookSettings: hookSettings(script, file) };
    } catch {
      return null;
    }
  }

  private async removeStatusFolder(status: StatusFolder) {
    await rm(status.folder, { recursive: true, force: true }).catch(() => {});
  }

  input(sessionId: string, runId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.terminal.write(data);
    else if (!this.pending.has(sessionId) && !this.finishing.has(sessionId)) {
      this.reportMissing(sessionId, runId);
    }
  }

  resize(sessionId: string, { cols, rows }: TerminalSize): void {
    this.sessions.get(sessionId)?.terminal.resize(cols, rows);
  }

  stop(sessionId: string, runId: string): void {
    const session = this.sessions.get(sessionId);
    const pending = this.pending.get(sessionId);
    if (session) {
      session.stopRequested = true;
      this.kill(session);
    } else if (pending) pending.cancelled = true;
    // A session that is finishing reports its own exit shortly.
    else if (!this.finishing.has(sessionId)) this.reportMissing(sessionId, runId);
  }

  stopAll(): void {
    this.stopped = true;
    for (const pending of this.pending.values()) pending.cancelled = true;
    for (const session of this.sessions.values()) this.kill(session);
    // Nothing starts after this, so the excludes file and status folders can go with the Worker.
    void this.excludes
      ?.then((path) => rm(dirname(path), { recursive: true, force: true }))
      .catch(() => {});
    void this.statusBase
      ?.then(({ base }) => rm(base, { recursive: true, force: true }))
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
