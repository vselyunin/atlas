import { describe, expect, it } from 'vitest';
import {
  AGENT_SESSION_CAPABILITY,
  AGENT_SESSION_STATUS_CAPABILITY,
  ApiToBoardSessionMessageSchema,
  DEFAULT_SESSION_SIZE,
  REPOSITORY_CLONE_CAPABILITY,
  REPOSITORY_INIT_CAPABILITY,
  SessionListResponseSchema,
  SessionSummarySchema,
  WorkerRegisterSchema,
  WorkerToApiMessageSchema,
  versionSessionsPath,
} from '../src/index.js';

const envelope = { protocolVersion: 1, messageId: 'message:example' };

function register(capabilities: unknown) {
  return {
    ...envelope,
    type: 'worker.register',
    payload: {
      workerId: 'atlas:example',
      name: 'Atlas',
      workspaceRoot: '/workspace',
      capabilities,
    },
  };
}

const ids = { sessionId: 'task:example', runId: 'run:example' };

describe('session status contracts', () => {
  it('registers the four-capability list and rejects the list without clone', () => {
    expect(AGENT_SESSION_STATUS_CAPABILITY).toBe('agent.session.status');
    expect(
      WorkerRegisterSchema.safeParse(
        register([
          REPOSITORY_INIT_CAPABILITY,
          AGENT_SESSION_CAPABILITY,
          REPOSITORY_CLONE_CAPABILITY,
          AGENT_SESSION_STATUS_CAPABILITY,
        ]),
      ).success,
    ).toBe(true);
    expect(
      WorkerRegisterSchema.safeParse(
        register([
          REPOSITORY_INIT_CAPABILITY,
          AGENT_SESSION_CAPABILITY,
          AGENT_SESSION_STATUS_CAPABILITY,
        ]),
      ).success,
    ).toBe(false);
  });

  it('parses session.activity with a known detail only', () => {
    const activity = (payload: object) => ({
      ...envelope,
      type: 'session.activity',
      payload: { ...ids, ...payload },
    });
    expect(
      WorkerToApiMessageSchema.safeParse(
        activity({ activity: 'needs_input', detail: 'asked_in_text' }),
      ).success,
    ).toBe(true);
    expect(
      WorkerToApiMessageSchema.safeParse(activity({ activity: 'working', detail: null })).success,
    ).toBe(true);
    expect(
      WorkerToApiMessageSchema.safeParse(activity({ activity: 'error', detail: 'free text' }))
        .success,
    ).toBe(false);
  });

  it('parses session.exit with and without stopped', () => {
    const exit = (extra: object) => ({
      ...envelope,
      type: 'session.exit',
      payload: { ...ids, exitCode: 0, message: null, ...extra },
    });
    expect(WorkerToApiMessageSchema.safeParse(exit({})).success).toBe(true);
    expect(WorkerToApiMessageSchema.safeParse(exit({ stopped: true })).success).toBe(true);
    expect(WorkerToApiMessageSchema.safeParse(exit({ stopped: 'yes' })).success).toBe(false);
  });

  it('parses session.sync with a starting session and rejects an unknown state', () => {
    const sync = (state: string) => ({
      ...envelope,
      type: 'session.sync',
      payload: {
        sessions: [
          { ...ids, state, worktreePath: null, branch: null, activity: null, detail: null },
        ],
        exits: [{ ...ids, exitCode: null, message: null, stopped: true }],
      },
    });
    expect(WorkerToApiMessageSchema.safeParse(sync('starting')).success).toBe(true);
    expect(WorkerToApiMessageSchema.safeParse(sync('exited')).success).toBe(false);
  });

  it('requires status, reason and since on the Board session message', () => {
    const base = {
      type: 'session',
      state: 'running',
      branch: null,
      worktreePath: null,
      exitCode: null,
      message: null,
    };
    const full = {
      ...base,
      status: 'working',
      reason: 'working',
      since: '2026-11-27T01:00:00.000Z',
    };
    expect(ApiToBoardSessionMessageSchema.safeParse(full).success).toBe(true);
    expect(ApiToBoardSessionMessageSchema.safeParse({ ...full, since: null }).success).toBe(true);
    expect(ApiToBoardSessionMessageSchema.safeParse(base).success).toBe(false);
    for (const key of ['status', 'reason', 'since']) {
      const rest: Record<string, unknown> = { ...full };
      delete rest[key];
      expect(ApiToBoardSessionMessageSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('parses the session summary and list response', () => {
    const summary = {
      status: 'none',
      reason: 'no_checkout',
      message: null,
      exitCode: null,
      since: null,
    };
    expect(SessionSummarySchema.safeParse(summary).success).toBe(true);
    expect(SessionSummarySchema.safeParse({ ...summary, status: 'busy' }).success).toBe(false);
    expect(
      SessionListResponseSchema.safeParse({ items: [{ taskId: 'task:a', ...summary }] }).success,
    ).toBe(true);
    expect(SessionListResponseSchema.safeParse({ items: [summary] }).success).toBe(false);
  });

  it('builds the version sessions path and exports the default size', () => {
    expect(versionSessionsPath('p1', 'v1')).toMatch(/\/projects\/p1\/versions\/v1\/sessions$/);
    expect(DEFAULT_SESSION_SIZE).toEqual({ cols: 120, rows: 30 });
  });
});
