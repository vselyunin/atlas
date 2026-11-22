import { z } from 'zod';
import { ErrorInfoSchema, IdSchema, NameSchema, RelativePathSchema } from './common.js';
import { API_BASE_PATH } from './http.js';
import {
  SessionExitPayloadSchema,
  SessionInputPayloadSchema,
  SessionOutputPayloadSchema,
  SessionResizePayloadSchema,
  SessionStartPayloadSchema,
  SessionStartedPayloadSchema,
  SessionStopPayloadSchema,
} from './sessions.js';
import { REPOSITORY_INIT_CAPABILITY } from './workers.js';

export const WORKER_CONNECT_PATH = `${API_BASE_PATH}/workers/connect`;
export const PROTOCOL_VERSION = 1;
export const MAX_WS_FRAME_BYTES = 256 * 1024;
export const REGISTRATION_TIMEOUT_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_STALE_MS = 30_000;
export const RECONNECT_INITIAL_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 30_000;

const envelope = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: IdSchema,
};
const commandEnvelope = { ...envelope, commandId: IdSchema };
const emptyPayload = z.strictObject({});

export const WorkerRegisterSchema = z.strictObject({
  ...envelope,
  type: z.literal('worker.register'),
  payload: z.strictObject({
    workerId: IdSchema,
    name: NameSchema,
    workspaceRoot: z.string(),
    capabilities: z.tuple([z.literal(REPOSITORY_INIT_CAPABILITY)]),
  }),
});

export const WorkerRegisteredSchema = z.strictObject({
  ...envelope,
  type: z.literal('worker.registered'),
  payload: z.strictObject({
    workerId: IdSchema,
    heartbeatIntervalMs: z.literal(HEARTBEAT_INTERVAL_MS),
  }),
});

export const WorkerHeartbeatSchema = z.strictObject({
  ...envelope,
  type: z.literal('worker.heartbeat'),
  payload: z.strictObject({ workerId: IdSchema }),
});

export const RepositoryInitCommandSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal('command.dispatch'),
  payload: z.strictObject({
    kind: z.literal(REPOSITORY_INIT_CAPABILITY),
    projectId: IdSchema,
    relativePath: RelativePathSchema,
  }),
});

export const CommandAcceptedSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal('command.accepted'),
  payload: emptyPayload,
});

export const CommandOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded'), localPath: z.string() }),
  z.strictObject({
    status: z.enum(['failed', 'needs_attention']),
    error: ErrorInfoSchema,
  }),
]);

export const CommandResultSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal('command.result'),
  payload: CommandOutcomeSchema,
});

export const CommandResultAckSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal('command.result_ack'),
  payload: emptyPayload,
});

export const ProtocolErrorSchema = z.strictObject({
  ...envelope,
  commandId: IdSchema.optional(),
  type: z.literal('protocol.error'),
  payload: ErrorInfoSchema,
});

// Spike: agent terminal sessions.
export const SessionStartSchema = z.strictObject({
  ...envelope,
  type: z.literal('session.start'),
  payload: SessionStartPayloadSchema,
});
export const SessionInputSchema = z.strictObject({
  ...envelope,
  type: z.literal('session.input'),
  payload: SessionInputPayloadSchema,
});
export const SessionResizeSchema = z.strictObject({
  ...envelope,
  type: z.literal('session.resize'),
  payload: SessionResizePayloadSchema,
});
export const SessionStopSchema = z.strictObject({
  ...envelope,
  type: z.literal('session.stop'),
  payload: SessionStopPayloadSchema,
});
export const SessionStartedSchema = z.strictObject({
  ...envelope,
  type: z.literal('session.started'),
  payload: SessionStartedPayloadSchema,
});
export const SessionOutputSchema = z.strictObject({
  ...envelope,
  type: z.literal('session.output'),
  payload: SessionOutputPayloadSchema,
});
export const SessionExitSchema = z.strictObject({
  ...envelope,
  type: z.literal('session.exit'),
  payload: SessionExitPayloadSchema,
});

export const WorkerToApiMessageSchema = z.discriminatedUnion('type', [
  WorkerRegisterSchema,
  WorkerHeartbeatSchema,
  CommandAcceptedSchema,
  CommandResultSchema,
  ProtocolErrorSchema,
  SessionStartedSchema,
  SessionOutputSchema,
  SessionExitSchema,
]);

export const ApiToWorkerMessageSchema = z.discriminatedUnion('type', [
  WorkerRegisteredSchema,
  RepositoryInitCommandSchema,
  CommandResultAckSchema,
  ProtocolErrorSchema,
  SessionStartSchema,
  SessionInputSchema,
  SessionResizeSchema,
  SessionStopSchema,
]);

export type SessionStarted = z.infer<typeof SessionStartedSchema>;
export type SessionOutput = z.infer<typeof SessionOutputSchema>;
export type SessionExit = z.infer<typeof SessionExitSchema>;

export type WorkerRegister = z.infer<typeof WorkerRegisterSchema>;
export type WorkerRegistered = z.infer<typeof WorkerRegisteredSchema>;
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;
export type RepositoryInitCommand = z.infer<typeof RepositoryInitCommandSchema>;
export type CommandAccepted = z.infer<typeof CommandAcceptedSchema>;
export type CommandOutcome = z.infer<typeof CommandOutcomeSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type CommandResultAck = z.infer<typeof CommandResultAckSchema>;
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
export type WorkerToApiMessage = z.infer<typeof WorkerToApiMessageSchema>;
export type ApiToWorkerMessage = z.infer<typeof ApiToWorkerMessageSchema>;
