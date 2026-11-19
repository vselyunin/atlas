import { z } from 'zod';
import { ErrorInfoSchema } from './common.js';
import { OperationSchema, ProjectSchema } from './projects.js';
import { TaskSchema } from './tasks.js';
import { VersionSchema } from './versions.js';
import { WorkerSchema } from './workers.js';

export const API_BASE_PATH = '/api/v1';
export const DEFAULT_API_PORT = 4310;
export const DEFAULT_BOARD_PORT = 5173;

export const ProjectListResponseSchema = z.strictObject({ items: z.array(ProjectSchema) });
export const ProjectResponseSchema = z.strictObject({ project: ProjectSchema });
export const ProjectCreateResponseSchema = ProjectResponseSchema.extend({
  operation: OperationSchema.nullable(),
});
export const VersionListResponseSchema = z.strictObject({ items: z.array(VersionSchema) });
export const VersionResponseSchema = z.strictObject({ version: VersionSchema });
export const WorkerListResponseSchema = z.strictObject({ items: z.array(WorkerSchema) });
export const TaskListResponseSchema = z.strictObject({ items: z.array(TaskSchema) });
export const TaskResponseSchema = z.strictObject({ task: TaskSchema });
export const OperationResponseSchema = z.strictObject({ operation: OperationSchema });
export const ErrorResponseSchema = z.strictObject({
  error: ErrorInfoSchema.extend({ details: z.unknown().optional() }),
});

export const ValidationErrorDetailsSchema = z.array(
  z.strictObject({
    path: z.array(z.union([z.string(), z.int()])),
    code: z.string(),
  }),
);

export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;
export type ProjectCreateResponse = z.infer<typeof ProjectCreateResponseSchema>;
export type VersionListResponse = z.infer<typeof VersionListResponseSchema>;
export type VersionResponse = z.infer<typeof VersionResponseSchema>;
export type WorkerListResponse = z.infer<typeof WorkerListResponseSchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type OperationResponse = z.infer<typeof OperationResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type ValidationErrorDetails = z.infer<typeof ValidationErrorDetailsSchema>;

export function invalidInputError(error: z.ZodError): ErrorResponse {
  const details: ValidationErrorDetails = error.issues.map(({ path, code }) => ({
    path: path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
    code,
  }));
  return { error: { code: 'invalid_input', message: 'Invalid input', details } };
}
