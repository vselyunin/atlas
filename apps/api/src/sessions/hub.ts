import { randomUUID } from 'node:crypto';
import {
  AGENT_SESSION_STATUS_CAPABILITY,
  DEFAULT_SESSION_SIZE,
  MAX_SESSION_PROMPT_CHARS,
  PROTOCOL_VERSION,
} from '@atlas/contracts';
import type {
  ApiToBoardSessionMessage,
  SessionActivity,
  SessionActivityDetail,
  SessionActivityPayload,
  SessionExit,
  SessionOutput,
  SessionStarted,
  SessionState,
  SessionSummary,
  TerminalSize,
} from '@atlas/contracts';
import { eq } from 'drizzle-orm';
import WebSocket from 'ws';
import type { ApiContext } from '../db/client.js';
import { tasks, workers } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { getProject } from '../projects/service.js';
import type { WorkerRegistry } from '../workers/registry.js';
import { summarize } from './status.js';

// Spike: sessions live in memory only. The task id is the session id.

const REPLAY_LIMIT_CHARS = 400_000;

interface Session {
  workerId: string;
  runId: string;
  state: Exclude<SessionState, 'none'>;
  branch: string | null;
  worktreePath: string | null;
  exitCode: number | null;
  message: string | null;
  activity: SessionActivity | null;
  detail: SessionActivityDetail | null;
  stopped: boolean;
  // Set when the Worker restarted without the session; reported by a later sync.
  lost: boolean;
  // When the task's summary last changed.
  since: string;
  chunks: string[];
  size: number;
}

// A start on a move that the API refused, kept until the next start or until the task leaves
// Working.
interface FailedStart {
  message: string;
  since: string;
}

// The close code for a socket whose sign-in session ended.
export const SESSION_ENDED_CLOSE_CODE = 4401;

interface Watch {
  timer: NodeJS.Timeout;
  check: () => void;
}

export class SessionHub {
  private readonly sessions = new Map<string, Session>();
  private readonly failedStarts = new Map<string, FailedStart>();
  private readonly viewers = new Map<string, Set<WebSocket>>();
  // Signed-in sockets by user, each with its session check and the timer that repeats it.
  private readonly watched = new Map<string, Map<WebSocket, Watch>>();

  constructor(
    private readonly context: ApiContext,
    private readonly registry: WorkerRegistry,
    private readonly recheckMs = 30_000,
  ) {}

  // Keeps a signed-in socket open only while `isValid` holds: rechecked on a timer, at once by
  // recheckUser, and ended by closeForUser. The timer stops when the socket closes.
  watch(socket: WebSocket, userId: string, isValid: () => boolean): void {
    const check = () => {
      let valid = false;
      try {
        valid = isValid();
      } catch {
        // A failed check counts as an ended session.
      }
      if (!valid) this.endSocket(socket);
    };
    const timer = setInterval(check, this.recheckMs);
    timer.unref();
    const sockets = this.watched.get(userId) ?? new Map<WebSocket, Watch>();
    sockets.set(socket, { timer, check });
    this.watched.set(userId, sockets);
    socket.once('close', () => {
      clearInterval(timer);
      sockets.delete(socket);
      if (sockets.size === 0 && this.watched.get(userId) === sockets) this.watched.delete(userId);
    });
  }

  // Ends every signed-in socket of the user: all their sessions are gone.
  closeForUser(userId: string): void {
    for (const socket of this.watched.get(userId)?.keys() ?? []) this.endSocket(socket);
  }

  // Checks the user's sockets now, for example after one of their sessions was signed out.
  recheckUser(userId: string): void {
    for (const { check } of this.watched.get(userId)?.values() ?? []) check();
  }

  // Stops every recheck timer; called when the API shuts down.
  close(): void {
    for (const sockets of this.watched.values()) {
      for (const { timer } of sockets.values()) clearInterval(timer);
    }
    this.watched.clear();
  }

  private endSocket(socket: WebSocket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(SESSION_ENDED_CLOSE_CODE, 'Sign in to continue');
    }
  }

  attach(taskId: string, socket: WebSocket): void {
    const viewers = this.viewers.get(taskId) ?? new Set();
    viewers.add(socket);
    this.viewers.set(taskId, viewers);
    this.deliver(socket, this.snapshot(taskId));
    const replay = this.sessions.get(taskId)?.chunks.join('');
    if (replay) this.deliver(socket, { type: 'output', data: replay });
  }

  detach(taskId: string, socket: WebSocket): void {
    const viewers = this.viewers.get(taskId);
    viewers?.delete(socket);
    if (viewers?.size === 0) this.viewers.delete(taskId);
  }

  start(taskId: string, size: TerminalSize): void {
    const current = this.sessions.get(taskId);
    if (current && current.state !== 'exited') return;
    const task = this.context.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) throw new ApiError(404, 'task_not_found', 'Task was not found');
    const project = getProject(this.context.db, task.projectId);
    if (project.repository.mode !== 'local' || project.state !== 'ready') {
      throw new ApiError(
        403,
        'no_checkout',
        'This project has no checkout on a worker, so a session cannot start here',
      );
    }
    const { workerId, relativePath } = project.repository;
    const worker = this.context.db.select().from(workers).where(eq(workers.id, workerId)).get();
    // A Worker that reports session status also runs sessions, so one check covers both.
    if (
      worker?.availability === 'online' &&
      !worker.capabilities.includes(AGENT_SESSION_STATUS_CAPABILITY)
    ) {
      throw new ApiError(
        409,
        'sessions_unsupported',
        'The project worker is too old to run agent sessions',
      );
    }
    // A fresh id per start lets late reports about an earlier run be told apart and ignored.
    const runId = randomUUID();
    const sent = this.registry.send(workerId, {
      protocolVersion: PROTOCOL_VERSION,
      messageId: randomUUID(),
      type: 'session.start',
      payload: {
        sessionId: taskId,
        runId,
        projectId: project.id,
        relativePath,
        // The label also keeps a title such as "--resume" from reading as an agent CLI option.
        prompt: `Task: ${task.title}\n\n${task.description}`
          .trim()
          .slice(0, MAX_SESSION_PROMPT_CHARS),
        ...size,
      },
    });
    if (!sent) throw new ApiError(503, 'worker_unavailable', 'The project worker is offline');
    this.sessions.set(taskId, {
      workerId,
      runId,
      state: 'starting',
      branch: null,
      worktreePath: null,
      exitCode: null,
      message: null,
      activity: null,
      detail: null,
      stopped: false,
      lost: false,
      since: this.context.now(),
      chunks: [],
      size: 0,
    });
    this.failedStarts.delete(taskId);
    this.broadcast(taskId, this.snapshot(taskId));
  }

  // Starts the task's session after a move into Working. A refusal is recorded for the task
  // instead of failing the move; a project without a checkout records nothing.
  startForMove(taskId: string): void {
    try {
      this.start(taskId, DEFAULT_SESSION_SIZE);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no_checkout') return;
      this.failedStarts.set(taskId, {
        message: error instanceof ApiError ? error.message : 'Unexpected session error',
        since: this.context.now(),
      });
      this.broadcast(taskId, this.snapshot(taskId));
    }
  }

  clearFailedStart(taskId: string): void {
    if (this.failedStarts.delete(taskId)) this.broadcast(taskId, this.snapshot(taskId));
  }

  summary(taskId: string): SessionSummary {
    const session = this.sessions.get(taskId);
    const failedStart = this.failedStarts.get(taskId);
    return summarize({
      session,
      failedStart,
      workerOnline: session ? this.registry.isOnline(session.workerId) : false,
      // Only a task with neither needs the database.
      hasCheckout: session || failedStart ? true : this.hasCheckout(taskId),
    });
  }

  // The summaries of the tasks that have a status to show.
  summaries(taskIds: string[]): Array<{ taskId: string } & SessionSummary> {
    return taskIds
      .map((taskId) => ({ taskId, ...this.summary(taskId) }))
      .filter(({ status }) => status !== 'none');
  }

  private hasCheckout(taskId: string): boolean {
    const task = this.context.db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    if (!task) return false;
    const project = getProject(this.context.db, task.projectId);
    return project.repository.mode === 'local' && project.state === 'ready';
  }

  input(taskId: string, data: string): void {
    this.forward(taskId, (workerId, runId) =>
      this.registry.send(workerId, {
        protocolVersion: PROTOCOL_VERSION,
        messageId: randomUUID(),
        type: 'session.input',
        payload: { sessionId: taskId, runId, data },
      }),
    );
  }

  resize(taskId: string, size: TerminalSize): void {
    this.forward(taskId, (workerId, runId) =>
      this.registry.send(workerId, {
        protocolVersion: PROTOCOL_VERSION,
        messageId: randomUUID(),
        type: 'session.resize',
        payload: { sessionId: taskId, runId, ...size },
      }),
    );
  }

  stop(taskId: string): void {
    this.forward(taskId, (workerId, runId) =>
      this.registry.send(workerId, {
        protocolVersion: PROTOCOL_VERSION,
        messageId: randomUUID(),
        type: 'session.stop',
        payload: { sessionId: taskId, runId },
      }),
    );
  }

  onStarted(
    workerId: string,
    { sessionId, runId, branch, worktreePath }: SessionStarted['payload'],
  ) {
    const session = this.owned(workerId, sessionId, runId);
    if (!session || session.state === 'exited') return;
    this.update(sessionId, session, { state: 'running', branch, worktreePath });
  }

  onActivity(workerId: string, { sessionId, runId, activity, detail }: SessionActivityPayload) {
    const session = this.owned(workerId, sessionId, runId);
    if (!session || session.state === 'exited') return;
    this.update(sessionId, session, { activity, detail });
  }

  onOutput(workerId: string, { sessionId, runId, data }: SessionOutput['payload']) {
    const session = this.owned(workerId, sessionId, runId);
    if (!session) return;
    session.chunks.push(data);
    session.size += data.length;
    while (session.size > REPLAY_LIMIT_CHARS && session.chunks.length > 1) {
      session.size -= session.chunks.shift()?.length ?? 0;
    }
    this.broadcast(sessionId, { type: 'output', data });
  }

  onExit(
    workerId: string,
    { sessionId, runId, exitCode, message, stopped }: SessionExit['payload'],
  ) {
    const session = this.owned(workerId, sessionId, runId);
    if (!session || session.state === 'exited') return;
    this.update(sessionId, session, {
      state: 'exited',
      exitCode,
      message,
      stopped: stopped ?? false,
    });
  }

  // Applies a change to a session, moves `since` when the summary changes, and tells the Board.
  private update(taskId: string, session: Session, changes: Partial<Session>) {
    const before = this.summaryWithoutSince(taskId);
    Object.assign(session, changes);
    if (this.summaryWithoutSince(taskId) !== before) session.since = this.context.now();
    this.broadcast(taskId, this.snapshot(taskId));
  }

  private summaryWithoutSince(taskId: string) {
    const { status, reason, message, exitCode } = this.summary(taskId);
    return JSON.stringify([status, reason, message, exitCode]);
  }

  private owned(workerId: string, taskId: string, runId: string) {
    const session = this.sessions.get(taskId);
    return session?.workerId === workerId && session.runId === runId ? session : undefined;
  }

  private forward(taskId: string, send: (workerId: string, runId: string) => boolean) {
    const session = this.sessions.get(taskId);
    if (!session || session.state === 'exited') return;
    if (!send(session.workerId, session.runId)) {
      throw new ApiError(503, 'worker_unavailable', 'The project worker is offline');
    }
  }

  private snapshot(taskId: string): ApiToBoardSessionMessage {
    const session = this.sessions.get(taskId);
    const { status, reason, since, message } = this.summary(taskId);
    return {
      type: 'session',
      state: session?.state ?? 'none',
      branch: session?.branch ?? null,
      worktreePath: session?.worktreePath ?? null,
      exitCode: session?.exitCode ?? null,
      // A refused start shows its reason; otherwise the session's own message.
      message: session && reason !== 'not_started' ? session.message : message,
      status,
      reason,
      since,
    };
  }

  private broadcast(taskId: string, message: ApiToBoardSessionMessage) {
    for (const socket of this.viewers.get(taskId) ?? []) this.deliver(socket, message);
  }

  deliver(socket: WebSocket, message: ApiToBoardSessionMessage) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}
