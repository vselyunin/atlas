import { z } from 'zod';
import { IdSchema, NameSchema, TimestampSchema } from './common.js';

export const HUMAN_WORKER_ID = 'human:vladi';
export const REPOSITORY_INIT_CAPABILITY = 'repository.init';
export const AGENT_SESSION_CAPABILITY = 'agent.session';
export const REPOSITORY_CLONE_CAPABILITY = 'repository.clone';

export const WorkerKindSchema = z.enum(['human', 'atlas']);
export const WorkerAvailabilitySchema = z.enum(['online', 'offline', 'not_applicable']);

export const WorkerSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  kind: WorkerKindSchema,
  availability: WorkerAvailabilitySchema,
  lastSeenAt: TimestampSchema.nullable(),
  workspaceRoot: z.string().nullable(),
  capabilities: z.array(z.string()),
});

export type WorkerKind = z.infer<typeof WorkerKindSchema>;
export type WorkerAvailability = z.infer<typeof WorkerAvailabilitySchema>;
export type Worker = z.infer<typeof WorkerSchema>;
