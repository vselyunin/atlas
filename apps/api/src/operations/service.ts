import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  PROTOCOL_VERSION,
  REPOSITORY_CLONE_CAPABILITY,
  REPOSITORY_INIT_CAPABILITY,
} from '@atlas/contracts';
import type { CommandDispatch, CommandResult, Operation } from '@atlas/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ApiContext, DbTransaction } from '../db/client.js';
import { operations, projects, workers } from '../db/schema.js';
import type { CredentialBroker } from '../github/credentials.js';
import { storedLink } from '../github/links.js';
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

// The command for an operation, by its kind, or null when it cannot be sent: a clone needs a Worker
// that can clone and the project's link for the repository's name.
function commandPayload(
  db: ApiContext['db'],
  operation: { kind: string; projectId: string },
  relativePath: string,
  capabilities: readonly string[],
): CommandDispatch['payload'] | null {
  const { projectId } = operation;
  if (operation.kind === REPOSITORY_INIT_CAPABILITY) {
    return { kind: REPOSITORY_INIT_CAPABILITY, projectId, relativePath };
  }
  if (operation.kind !== REPOSITORY_CLONE_CAPABILITY) return null;
  if (!capabilities.includes(REPOSITORY_CLONE_CAPABILITY)) return null;
  const link = storedLink(db, projectId);
  if (!link) return null;
  return { kind: REPOSITORY_CLONE_CAPABILITY, projectId, relativePath, repository: link.fullName };
}

export function dispatchPending(
  context: ApiContext,
  registry: WorkerRegistry,
  workerId: string,
  operationId?: string,
  broker?: CredentialBroker,
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
    const payload = worker
      ? commandPayload(db, operation, repository.relativePath, worker.capabilities)
      : null;
    // A reconfigured Worker must not initialize an outstanding job at a different target.
    const dispatched =
      payload !== null &&
      worker?.workspaceRoot === operation.workspaceRoot &&
      registry.send(workerId, {
        protocolVersion: PROTOCOL_VERSION,
        messageId: randomUUID(),
        type: 'command.dispatch',
        commandId: operation.id,
        payload,
      });
    if (dispatched && payload.kind === REPOSITORY_CLONE_CAPABILITY) {
      const socket = registry.socketOf(workerId);
      if (socket) broker?.noteDispatch(operation.id, socket);
    }
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
