import { z } from 'zod';
import {
  ErrorInfoSchema,
  IdSchema,
  NameSchema,
  RelativePathSchema,
  TimestampSchema,
} from './common.js';
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
import { GithubFullNameSchema } from './github.js';
import {
  AGENT_SESSION_CAPABILITY,
  REPOSITORY_CLONE_CAPABILITY,
  REPOSITORY_INIT_CAPABILITY,
} from './workers.js';

export const WORKER_CONNECT_PATH = `${API_BASE_PATH}/workers/connect`;
export const PROTOCOL_VERSION = 1;
export const MAX_WS_FRAME_BYTES = 256 * 1024;
export const REGISTRATION_TIMEOUT_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_STALE_MS = 30_000;
export const RECONNECT_INITIAL_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 30_000;
// How long after dispatch the API still grants a credential for a clone.
export const CREDENTIAL_GRANT_WINDOW_MS = 900_000;
// How long the Worker waits for a reply to a credential request.
export const CREDENTIAL_REPLY_TIMEOUT_MS = 30_000;

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
    // Workers that predate agent sessions advertise only repository initialization.
    // Workers that predate cloning omit the clone capability.
    capabilities: z.union([
      z.tuple([z.literal(REPOSITORY_INIT_CAPABILITY)]),
      z.tuple([z.literal(REPOSITORY_INIT_CAPABILITY), z.literal(AGENT_SESSION_CAPABILITY)]),
      z.tuple([
        z.literal(REPOSITORY_INIT_CAPABILITY),
        z.literal(AGENT_SESSION_CAPABILITY),
        z.literal(REPOSITORY_CLONE_CAPABILITY),
      ]),
    ]),
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

// The credential never travels in the command: the Worker asks for one by command ID.
export const RepositoryCloneCommandSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal('command.dispatch'),
  payload: z.strictObject({
    kind: z.literal(REPOSITORY_CLONE_CAPABILITY),
    projectId: IdSchema,
    relativePath: RelativePathSchema,
    repository: GithubFullNameSchema,
  }),
});

export const CommandDispatchSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal('command.dispatch'),
  payload: z.discriminatedUnion('kind', [
    RepositoryInitCommandSchema.shape.payload,
    RepositoryCloneCommandSchema.shape.payload,
  ]),
});

export const CredentialRequestSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal('credential.request'),
  payload: emptyPayload,
});

export const CredentialGrantSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal('credential.grant'),
  payload: z.strictObject({
    token: z.string().min(1),
    expiresAt: TimestampSchema,
    repository: GithubFullNameSchema,
  }),
});

export const CredentialRefusalSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal('credential.refusal'),
  payload: ErrorInfoSchema,
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
  CredentialRequestSchema,
  ProtocolErrorSchema,
  SessionStartedSchema,
  SessionOutputSchema,
  SessionExitSchema,
]);

export const ApiToWorkerMessageSchema = z.discriminatedUnion('type', [
  WorkerRegisteredSchema,
  CommandDispatchSchema,
  CommandResultAckSchema,
  CredentialGrantSchema,
  CredentialRefusalSchema,
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
export type RepositoryCloneCommand = z.infer<typeof RepositoryCloneCommandSchema>;
export type CommandDispatch = z.infer<typeof CommandDispatchSchema>;
export type CredentialRequest = z.infer<typeof CredentialRequestSchema>;
export type CredentialGrant = z.infer<typeof CredentialGrantSchema>;
export type CredentialRefusal = z.infer<typeof CredentialRefusalSchema>;
export type CommandAccepted = z.infer<typeof CommandAcceptedSchema>;
export type CommandOutcome = z.infer<typeof CommandOutcomeSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type CommandResultAck = z.infer<typeof CommandResultAckSchema>;
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
export type WorkerToApiMessage = z.infer<typeof WorkerToApiMessageSchema>;
export type ApiToWorkerMessage = z.infer<typeof ApiToWorkerMessageSchema>;
