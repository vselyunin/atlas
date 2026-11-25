import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { REPOSITORY_INIT_CAPABILITY } from '@atlas/contracts';
import type { Operation, Project, ProjectCreate, ProjectCreateResponse } from '@atlas/contracts';
import { asc, eq } from 'drizzle-orm';
import type { ApiContext, DbTransaction } from '../db/client.js';
import { operations, projectFields, projects, workers } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { addVersion } from '../versions/service.js';
import type { WorkerRegistry } from '../workers/registry.js';

export function getProject(db: ApiContext['db'] | DbTransaction, projectId: string): Project {
  const project = db.select(projectFields).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new ApiError(404, 'project_not_found', 'Project was not found');
  return project;
}

export function requireReadyProject(
  db: ApiContext['db'] | DbTransaction,
  projectId: string,
): Project {
  const project = getProject(db, projectId);
  if (project.state !== 'ready')
    throw new ApiError(403, 'project_not_ready', 'Project is not ready');
  return project;
}

export function listProjects(context: ApiContext): Project[] {
  return context.db
    .select(projectFields)
    .from(projects)
    .orderBy(asc(projects.createdAt), asc(projects.name))
    .all();
}

export function createProject(
  context: ApiContext,
  registry: WorkerRegistry,
  input: ProjectCreate,
): ProjectCreateResponse {
  return context.db.transaction(
    (tx) => {
      const now = context.now();
      const project: Project = {
        id: randomUUID(),
        name: input.name,
        repository:
          input.repository.mode === 'existing'
            ? input.repository
            : { ...input.repository, localPath: null },
        state: 'ready',
        operationId: null,
        createdAt: now,
        updatedAt: now,
      };
      if (input.repository.mode === 'existing') {
        tx.insert(projects).values(project).run();
        addVersion(tx, project.id, 'v0.1', now);
        return { project, operation: null };
      }
      const { workerId, relativePath } = input.repository;
      if (
        relativePath.includes('\\') ||
        relativePath.split('/').includes('..') ||
        posix.normalize(relativePath).replace(/\/$/, '') === '.'
      ) {
        throw new ApiError(
          400,
          'invalid_relative_path',
          'Choose a folder under the Worker workspace',
        );
      }
      const worker = tx.select().from(workers).where(eq(workers.id, workerId)).get();
      if (
        worker?.kind !== 'atlas' ||
        !worker.workspaceRoot ||
        !worker.capabilities.includes(REPOSITORY_INIT_CAPABILITY) ||
        !registry.isOnline(workerId)
      ) {
        throw new ApiError(503, 'worker_unavailable', 'An online repository Worker is required');
      }
      const operation: Operation = {
        id: randomUUID(),
        projectId: project.id,
        workerId,
        state: 'pending',
        connectionLost: false,
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      project.state = 'pending';
      project.operationId = operation.id;
      tx.insert(projects).values(project).run();
      tx.insert(operations)
        .values({ ...operation, workspaceRoot: worker.workspaceRoot })
        .run();
      return { project, operation };
    },
    { behavior: 'immediate' },
  );
}
