import { z } from 'zod';
import {
  ErrorInfoSchema,
  IdSchema,
  NameSchema,
  RelativePathSchema,
  TimestampSchema,
} from './common.js';

const scpRepository = /^git@(?:[a-z\d](?:[a-z\d.-]*[a-z\d])?|\[[a-f\d:]+\]):[^\\\s]+$/i;

export const GitUrlSchema = z.string().refine(
  (value) => {
    if (/[\\\s?#]/.test(value)) return false;
    if (scpRepository.test(value)) return true;

    const authority = /^(?:https|ssh):\/\/([^/]+)\//i.exec(value)?.[1];
    if (!authority) return false;

    try {
      const url = new URL(value);
      const userInfo = authority.split('@');
      if (!url.hostname || !url.pathname.replaceAll('/', '') || url.password) return false;
      if (userInfo.length === 1) return true;
      return (
        url.protocol === 'ssh:' &&
        userInfo.length === 2 &&
        url.username.length > 0 &&
        !userInfo[0]?.includes(':')
      );
    } catch {
      return false;
    }
  },
  { message: 'Expected an HTTPS, SSH, or git@host:path repository URL without credentials' },
);

const ExistingRepositorySchema = z.strictObject({
  mode: z.literal('existing'),
  gitUrl: GitUrlSchema,
});

const LocalRepositoryCreateSchema = z.strictObject({
  mode: z.literal('local'),
  workerId: IdSchema,
  relativePath: RelativePathSchema,
});

export const RepositorySchema = z.discriminatedUnion('mode', [
  ExistingRepositorySchema,
  LocalRepositoryCreateSchema.extend({ localPath: z.string().nullable() }),
]);

export const ProjectCreateSchema = z.strictObject({
  name: NameSchema,
  repository: z.discriminatedUnion('mode', [ExistingRepositorySchema, LocalRepositoryCreateSchema]),
});

export const ProjectStateSchema = z.enum(['pending', 'ready', 'failed', 'needs_attention']);

export const ProjectSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  repository: RepositorySchema,
  state: ProjectStateSchema,
  operationId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const OperationStateSchema = z.enum([
  'pending',
  'accepted',
  'succeeded',
  'failed',
  'needs_attention',
]);

export const OperationSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  workerId: IdSchema,
  state: OperationStateSchema,
  connectionLost: z.boolean(),
  result: z.strictObject({ localPath: z.string() }).nullable(),
  error: ErrorInfoSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type Repository = z.infer<typeof RepositorySchema>;
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;
export type ProjectState = z.infer<typeof ProjectStateSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type OperationState = z.infer<typeof OperationStateSchema>;
export type Operation = z.infer<typeof OperationSchema>;
