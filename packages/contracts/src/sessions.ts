import { z } from 'zod';
import { IdSchema } from './common.js';
import { API_BASE_PATH } from './http.js';

// Spike: agent terminal sessions. One session per task; the task id is the session id.

export const MAX_SESSION_INPUT_CHARS = 8_192;
export const MAX_SESSION_OUTPUT_CHARS = 16_000;
export const MAX_SESSION_PROMPT_CHARS = 20_000;

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
});

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
  }),
  z.strictObject({ type: z.literal('output'), data: z.string() }),
  z.strictObject({ type: z.literal('error'), message: z.string() }),
]);

export type TerminalSize = z.infer<typeof TerminalSizeSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;
export type BoardToApiSessionMessage = z.infer<typeof BoardToApiSessionMessageSchema>;
export type ApiToBoardSessionMessage = z.infer<typeof ApiToBoardSessionMessageSchema>;
