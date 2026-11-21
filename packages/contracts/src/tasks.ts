import { z } from 'zod';
import { IdSchema, NameSchema, RevisionSchema, TimestampSchema } from './common.js';

export const TaskStatusSchema = z.enum(['backlog', 'todo', 'working', 'done']);
export const TaskTypeSchema = z.enum(['epic', 'story', 'task', 'bug']);
export const PrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type Priority = z.infer<typeof PrioritySchema>;

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  backlog: 'Backlog',
  todo: 'To do',
  working: 'Working',
  done: 'Done',
};

const editableTaskFields = {
  title: NameSchema,
  description: z.string().max(100_000),
  type: TaskTypeSchema,
  priority: PrioritySchema,
  assigneeId: IdSchema.nullable(),
};

export const TaskSchema = z.strictObject({
  ...editableTaskFields,
  id: IdSchema,
  projectId: IdSchema,
  versionId: IdSchema,
  status: TaskStatusSchema,
  position: z.int().min(0),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const TaskCreateSchema = z.strictObject({
  status: z.enum(['backlog', 'todo']).optional(),
  ...editableTaskFields,
  description: editableTaskFields.description.default(''),
  type: TaskTypeSchema.default('task'),
  priority: PrioritySchema.default('medium'),
  assigneeId: editableTaskFields.assigneeId.default(null),
});

export const TaskChangesSchema = z
  .strictObject({ ...editableTaskFields, versionId: IdSchema })
  .partial()
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: 'At least one task change is required',
  });

export const TaskPatchSchema = z.strictObject({
  expectedRevision: RevisionSchema,
  changes: TaskChangesSchema,
});

export const TaskMoveSchema = z.strictObject({
  expectedRevision: RevisionSchema,
  status: TaskStatusSchema,
  beforeTaskId: IdSchema.nullable(),
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type TaskChanges = z.infer<typeof TaskChangesSchema>;
export type TaskPatch = z.infer<typeof TaskPatchSchema>;
export type TaskMove = z.infer<typeof TaskMoveSchema>;
