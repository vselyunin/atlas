import { randomUUID } from 'node:crypto';
import {
  AGENT_SESSION_CAPABILITY,
  MAX_SESSION_PROMPT_CHARS,
  PROTOCOL_VERSION,
} from '@atlas/contracts';
import type {
  ApiToBoardSessionMessage,
  SessionExit,
  SessionOutput,
  SessionStarted,
  SessionState,
  TerminalSize,
} from '@atlas/contracts';
import { eq } from 'drizzle-orm';
import WebSocket from 'ws';
import type { ApiContext } from '../db/client.js';
import { tasks, workers } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { getProject } from '../projects/service.js';
import type { WorkerRegistry } from '../workers/registry.js';

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
  chunks: string[];
  size: number;
}

export class SessionHub {
  private readonly sessions = new Map<string, Session>();
  private readonly viewers = new Map<string, Set<WebSocket>>();

  constructor(
    private readonly context: ApiContext,
    private readonly registry: WorkerRegistry,
  ) {}

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
    if (
      worker?.availability === 'online' &&
      !worker.capabilities.includes(AGENT_SESSION_CAPABILITY)
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
      chunks: [],
      size: 0,
    });
    this.broadcast(taskId, this.snapshot(taskId));
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
    if (!session) return;
    Object.assign(session, { state: 'running', branch, worktreePath });
    this.broadcast(sessionId, this.snapshot(sessionId));
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

  onExit(workerId: string, { sessionId, runId, exitCode, message }: SessionExit['payload']) {
    const session = this.owned(workerId, sessionId, runId);
    if (!session || session.state === 'exited') return;
    Object.assign(session, { state: 'exited', exitCode, message });
    this.broadcast(sessionId, this.snapshot(sessionId));
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
    return {
      type: 'session',
      state: session?.state ?? 'none',
      branch: session?.branch ?? null,
      worktreePath: session?.worktreePath ?? null,
      exitCode: session?.exitCode ?? null,
      message: session?.message ?? null,
    };
  }

  private broadcast(taskId: string, message: ApiToBoardSessionMessage) {
    for (const socket of this.viewers.get(taskId) ?? []) this.deliver(socket, message);
  }

  deliver(socket: WebSocket, message: ApiToBoardSessionMessage) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}
