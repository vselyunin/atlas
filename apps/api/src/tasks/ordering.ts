import type { Task, TaskStatus } from '@atlas/contracts';
import { and, asc, eq } from 'drizzle-orm';
import type { DbTransaction } from '../db/client.js';
import { taskFields, tasks } from '../db/schema.js';

export function readColumn(
  tx: DbTransaction,
  projectId: string,
  versionId: string,
  status: TaskStatus,
) {
  return tx
    .select(taskFields)
    .from(tasks)
    .where(
      and(eq(tasks.projectId, projectId), eq(tasks.versionId, versionId), eq(tasks.status, status)),
    )
    .orderBy(asc(tasks.position))
    .all();
}

export function updateTask(
  tx: DbTransaction,
  task: Task,
  changes: Partial<Task>,
  now: string,
): Task {
  const update = { ...changes, revision: task.revision + 1, updatedAt: now };
  tx.update(tasks).set(update).where(eq(tasks.id, task.id)).run();
  return { ...task, ...update };
}

export function compactColumn(tx: DbTransaction, ordered: Task[], now: string) {
  ordered.forEach((task, position) => {
    if (task.position !== position) updateTask(tx, task, { position }, now);
  });
}
