import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { API_BASE_PATH } from './http.js';

// Spike: agent terminal sessions. One session per task; the task id is the session id.

export const MAX_SESSION_INPUT_CHARS = 8_192;
export const MAX_SESSION_OUTPUT_CHARS = 16_000;
export const MAX_SESSION_PROMPT_CHARS = 20_000;

export const DEFAULT_SESSION_SIZE = { cols: 120, rows: 30 } as const;

export const taskSessionPath = (taskId: string) =>
  `${API_BASE_PATH}/tasks/${encodeURIComponent(taskId)}/session`;

export const TerminalSizeSchema = z.strictObject({
  cols: z.int().min(2).max(500),
  rows: z.int().min(1).max(300),
});

export const SessionStateSchema = z.enum(['none', 'starting', 'running', 'exited']);

// Worker socket payloads.

export const SessionStartPayloadSchema = z.strictObject({
  sessionId: IdSchema,
  runId: IdSchema,
  projectId: IdSchema,
  relativePath: z.string().min(1).max(1_024),
  prompt: z.string().max(MAX_SESSION_PROMPT_CHARS),
  ...TerminalSizeSchema.shape,
});

export const SessionInputPayloadSchema = z.strictObject({
  sessionId: IdSchema,
  runId: IdSchema,
  data: z.string().min(1).max(MAX_SESSION_INPUT_CHARS),
});

export const SessionResizePayloadSchema = z.strictObject({
  sessionId: IdSchema,
  runId: IdSchema,
  ...TerminalSizeSchema.shape,
});

export const SessionStopPayloadSchema = z.strictObject({ sessionId: IdSchema, runId: IdSchema });

export const SessionStartedPayloadSchema = z.strictObject({
  sessionId: IdSchema,
  runId: IdSchema,
  worktreePath: z.string(),
  branch: z.string(),
});

export const SessionOutputPayloadSchema = z.strictObject({
  sessionId: IdSchema,
  runId: IdSchema,
  data: z.string().max(MAX_SESSION_OUTPUT_CHARS),
});

export const SessionExitPayloadSchema = z.strictObject({
  sessionId: IdSchema,
  runId: IdSchema,
  exitCode: z.int().nullable(),
  message: z.string().nullable(),
  stopped: z.boolean().optional(),
});

export const SessionActivitySchema = z.enum(['working', 'needs_input', 'idle', 'error']);

export const SessionActivityDetailSchema = z.enum([
  'asked_in_text',
  'resumed',
  'rate_limit',
  'authentication_failed',
  'billing_error',
  'invalid_request',
  'server_error',
  'max_output_tokens',
  'unknown',
]);

export const SessionActivityPayloadSchema = z.strictObject({
  sessionId: IdSchema,
  runId: IdSchema,
  activity: SessionActivitySchema,
  detail: SessionActivityDetailSchema.nullable(),
});

export const SessionSyncPayloadSchema = z.strictObject({
  sessions: z
    .array(
      z.strictObject({
        sessionId: IdSchema,
        runId: IdSchema,
        state: z.enum(['starting', 'running']),
        worktreePath: z.string().nullable(),
        branch: z.string().nullable(),
        activity: SessionActivitySchema.nullable(),
        detail: SessionActivityDetailSchema.nullable(),
      }),
    )
    .max(500),
  exits: z.array(SessionExitPayloadSchema).max(500),
});

// Derived status shown on the Board, with the reason it was derived.

export const SessionStatusSchema = z.enum([
  'none',
  'working',
  'needs_input',
  'finished',
  'problem',
  'ended',
]);

export const SessionReasonSchema = z.enum([
  'none',
  'no_checkout',
  'starting',
  'working',
  'dialog',
  'asked_in_text',
  'finished',
  'resumed',
  'not_started',
  'start_failed',
  'exit_error',
  'api_error',
  'worker_offline',
  'worker_lost',
  'exited',
  'stopped',
]);

export const SessionSummarySchema = z.strictObject({
  status: SessionStatusSchema,
  reason: SessionReasonSchema,
  message: z.string().nullable(),
  exitCode: z.int().nullable(),
  since: TimestampSchema.nullable(),
});

export const SessionListResponseSchema = z.strictObject({
  items: z.array(z.strictObject({ taskId: IdSchema, ...SessionSummarySchema.shape })),
});

export const versionSessionsPath = (projectId: string, versionId: string) =>
  `${API_BASE_PATH}/projects/${projectId}/versions/${versionId}/sessions`;

// Board socket messages.

export const BoardToApiSessionMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('start'), ...TerminalSizeSchema.shape }),
  z.strictObject({
    type: z.literal('input'),
    data: z.string().min(1).max(MAX_SESSION_INPUT_CHARS),
  }),
  z.strictObject({ type: z.literal('resize'), ...TerminalSizeSchema.shape }),
  z.strictObject({ type: z.literal('stop') }),
]);

export const ApiToBoardSessionMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session'),
    state: SessionStateSchema,
    branch: z.string().nullable(),
    worktreePath: z.string().nullable(),
    exitCode: z.int().nullable(),
    message: z.string().nullable(),
    status: SessionStatusSchema,
    reason: SessionReasonSchema,
    since: TimestampSchema.nullable(),
  }),
  z.strictObject({ type: z.literal('output'), data: z.string() }),
  z.strictObject({ type: z.literal('error'), message: z.string() }),
]);

export type TerminalSize = z.infer<typeof TerminalSizeSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;
export type SessionActivity = z.infer<typeof SessionActivitySchema>;
export type SessionActivityDetail = z.infer<typeof SessionActivityDetailSchema>;
export type SessionActivityPayload = z.infer<typeof SessionActivityPayloadSchema>;
export type SessionSyncPayload = z.infer<typeof SessionSyncPayloadSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionReason = z.infer<typeof SessionReasonSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type BoardToApiSessionMessage = z.infer<typeof BoardToApiSessionMessageSchema>;
export type ApiToBoardSessionMessage = z.infer<typeof ApiToBoardSessionMessageSchema>;
