import { randomUUID } from 'node:crypto';
import type { Task, TaskCreate, TaskMove, TaskPatch } from '@atlas/contracts';
import { and, asc, eq } from 'drizzle-orm';
import type { ApiContext, DbTransaction } from '../db/client.js';
import { tasks, workers } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { requireReadyProject } from '../projects/service.js';
import { requireVersion } from '../versions/service.js';
import { compactColumn, readColumn, updateTask } from './ordering.js';

function requireAssignee(db: DbTransaction, id: string | null | undefined) {
  if (id && !db.select({ id: workers.id }).from(workers).where(eq(workers.id, id)).get()) {
    throw new ApiError(404, 'assignee_not_found', 'Assignee was not found');
  }
}

function requireCurrentTask(tx: DbTransaction, taskId: string, expectedRevision: number): Task {
  const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new ApiError(404, 'task_not_found', 'Task was not found');
  requireReadyProject(tx, task.projectId);
  if (task.revision !== expectedRevision) {
    throw new ApiError(409, 'revision_conflict', 'The task changed. Refresh it and try again');
  }
  return task;
}

export function listTasks({ db }: ApiContext, projectId: string, versionId: string): Task[] {
  requireReadyProject(db, projectId);
  requireVersion(db, projectId, versionId);
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.versionId, versionId)))
    .orderBy(asc(tasks.status), asc(tasks.position))
    .all();
}

export function createTask(
  context: ApiContext,
  projectId: string,
  versionId: string,
  input: TaskCreate,
): Task {
  return context.db.transaction(
    (tx) => {
      requireReadyProject(tx, projectId);
      requireVersion(tx, projectId, versionId);
      requireAssignee(tx, input.assigneeId);
      const now = context.now();
      const task: Task = {
        ...input,
        id: randomUUID(),
        projectId,
        versionId,
        status: input.status ?? 'backlog',
        position: readColumn(tx, projectId, versionId, input.status ?? 'backlog').length,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(tasks).values(task).run();
      return task;
    },
    { behavior: 'immediate' },
  );
}

export function patchTask(
  context: ApiContext,
  taskId: string,
  { expectedRevision, changes }: TaskPatch,
): Task {
  return context.db.transaction(
    (tx) => {
      const task = requireCurrentTask(tx, taskId, expectedRevision);
      if (
        task.status === 'done' ||
        (task.status === 'working' && Object.keys(changes).some((key) => key !== 'description'))
      ) {
        throw new ApiError(
          403,
          'field_locked',
          'One or more task fields are locked in this column',
        );
      }
      requireAssignee(tx, changes.assigneeId);
      const now = context.now();
      const { versionId } = changes;
      if (versionId && versionId !== task.versionId) {
        requireVersion(tx, task.projectId, versionId);
        const position = readColumn(tx, task.projectId, versionId, task.status).length;
        const relocated = updateTask(tx, task, { ...changes, position }, now);
        const remaining = readColumn(tx, task.projectId, task.versionId, task.status);
        compactColumn(tx, remaining, now);
        return relocated;
      }
      return updateTask(tx, task, changes, now);
    },
    { behavior: 'immediate' },
  );
}

export function moveTask(
  context: ApiContext,
  taskId: string,
  { expectedRevision, status, beforeTaskId }: TaskMove,
): Task {
  return context.db.transaction(
    (tx) => {
      const task = requireCurrentTask(tx, taskId, expectedRevision);
      if (beforeTaskId === task.id) return task;
      const destination = readColumn(tx, task.projectId, task.versionId, status).filter(
        (row) => row.id !== task.id,
      );
      const position =
        beforeTaskId === null
          ? destination.length
          : destination.findIndex((row) => row.id === beforeTaskId);
      if (position < 0)
        throw new ApiError(
          409,
          'invalid_anchor',
          'The destination task is no longer in that column',
        );
      if (task.status === status && task.position === position) return task;

      const now = context.now();
      const moved = updateTask(tx, task, { status, position }, now);
      destination.splice(position, 0, moved);
      compactColumn(tx, destination, now);
      if (status !== task.status) {
        compactColumn(tx, readColumn(tx, task.projectId, task.versionId, task.status), now);
      }
      return moved;
    },
    { behavior: 'immediate' },
  );
}
