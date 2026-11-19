import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PROTOCOL_VERSION, REPOSITORY_INIT_CAPABILITY } from '@atlas/contracts';
import type { CommandResult, Operation } from '@atlas/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ApiContext, DbTransaction } from '../db/client.js';
import { operations, projects, workers } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { getProject } from '../projects/service.js';
import { addVersion } from '../versions/service.js';
import type { WorkerRegistry } from '../workers/registry.js';

function findOperation(db: ApiContext['db'] | DbTransaction, id: string) {
  const operation = db.select().from(operations).where(eq(operations.id, id)).get();
  if (!operation) throw new ApiError(404, 'operation_not_found', 'Unknown repository operation');
  return operation;
}

export function getOperation({ db }: ApiContext, id: string): Operation {
  const row = findOperation(db, id);
  return {
    id: row.id,
    projectId: row.projectId,
    workerId: row.workerId,
    state: row.state,
    connectionLost: row.connectionLost,
    result: row.result,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireAssignedOperation(tx: DbTransaction, workerId: string, commandId: string) {
  const operation = findOperation(tx, commandId);
  if (operation.workerId !== workerId) {
    throw new ApiError(403, 'wrong_worker', 'That operation is assigned to a different Worker');
  }
  return operation;
}

export function dispatchPending(
  context: ApiContext,
  registry: WorkerRegistry,
  workerId: string,
  operationId?: string,
): void {
  const { db, now } = context;
  const worker = db.select().from(workers).where(eq(workers.id, workerId)).get();
  const pending = db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.workerId, workerId),
        inArray(operations.state, ['pending', 'accepted']),
        operationId === undefined ? undefined : eq(operations.id, operationId),
      ),
    )
    .orderBy(asc(operations.createdAt))
    .all();

  for (const operation of pending) {
    const { projectId } = operation;
    const { repository } = getProject(db, projectId);
    if (repository.mode !== 'local') throw new Error('Expected a local project');
    // A reconfigured Worker must not initialize an outstanding job at a different target.
    const dispatched =
      worker?.workspaceRoot === operation.workspaceRoot &&
      registry.send(workerId, {
        protocolVersion: PROTOCOL_VERSION,
        messageId: randomUUID(),
        type: 'command.dispatch',
        commandId: operation.id,
        payload: {
          kind: REPOSITORY_INIT_CAPABILITY,
          projectId,
          relativePath: repository.relativePath,
        },
      });
    if (operation.connectionLost === dispatched) {
      db.update(operations)
        .set({ connectionLost: !dispatched, updatedAt: now() })
        .where(eq(operations.id, operation.id))
        .run();
    }
  }
}

export function applyAcceptance({ db, now }: ApiContext, workerId: string, commandId: string) {
  db.transaction(
    (tx) => {
      const operation = requireAssignedOperation(tx, workerId, commandId);
      if (operation.state === 'pending') {
        tx.update(operations)
          .set({ state: 'accepted', updatedAt: now() })
          .where(eq(operations.id, commandId))
          .run();
      }
    },
    { behavior: 'immediate' },
  );
}

export function applyResult(
  { db, now }: ApiContext,
  workerId: string,
  { commandId, payload }: CommandResult,
): void {
  db.transaction(
    (tx) => {
      const operation = requireAssignedOperation(tx, workerId, commandId);
      const result = payload.status === 'succeeded' ? { localPath: payload.localPath } : null;
      const error = payload.status === 'succeeded' ? null : payload.error;
      if (operation.state !== 'pending' && operation.state !== 'accepted') {
        if (
          operation.state !== payload.status ||
          !isDeepStrictEqual(operation.result, result) ||
          !isDeepStrictEqual(operation.error, error)
        ) {
          throw new ApiError(
            409,
            'result_conflict',
            'This operation already has a different result',
          );
        }
        return;
      }

      const project = getProject(tx, operation.projectId);
      if (project.repository.mode !== 'local') throw new Error('Expected a local project');
      const stamp = now();
      if (result) {
        const expectedPath = posix.resolve(
          operation.workspaceRoot,
          project.repository.relativePath,
        );
        if (result.localPath !== expectedPath) {
          throw new ApiError(
            400,
            'invalid_result_path',
            'Repository result did not match the selected destination',
          );
        }
        addVersion(tx, project.id, 'v0.1', stamp);
      }
      tx.update(projects)
        .set({
          state: payload.status === 'succeeded' ? 'ready' : payload.status,
          repository: result
            ? { ...project.repository, localPath: result.localPath }
            : project.repository,
          updatedAt: stamp,
        })
        .where(eq(projects.id, project.id))
        .run();
      tx.update(operations)
        .set({
          state: payload.status,
          connectionLost: false,
          result,
          error,
          updatedAt: stamp,
        })
        .where(eq(operations.id, commandId))
        .run();
    },
    { behavior: 'immediate' },
  );
}
