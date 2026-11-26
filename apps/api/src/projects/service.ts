import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { REPOSITORY_CLONE_CAPABILITY, REPOSITORY_INIT_CAPABILITY } from '@atlas/contracts';
import type {
  GithubRepository,
  Operation,
  Project,
  ProjectCreate,
  ProjectCreateResponse,
} from '@atlas/contracts';
import { asc, eq } from 'drizzle-orm';
import type { ApiContext, DbTransaction } from '../db/client.js';
import { githubLinks, operations, projectFields, projects, workers } from '../db/schema.js';
import type { AppFile } from '../github/app-file.js';
import { GitHubError } from '../github/client.js';
import type { GitHubClient } from '../github/client.js';
import { ApiError } from '../http/errors.js';
import { addVersion } from '../versions/service.js';
import type { WorkerRegistry } from '../workers/registry.js';

// The GitHub App and its client; absent while sign-in is off.
export type ProjectGithub = { appFile: AppFile; client: GitHubClient };

type LocalCreate = Extract<ProjectCreate['repository'], { mode: 'local' }>;

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

function assertRelativePath(relativePath: string) {
  if (
    relativePath.includes('\\') ||
    relativePath.startsWith('.') ||
    relativePath.split('/').includes('..') ||
    posix.normalize(relativePath).replace(/\/$/, '') === '.'
  ) {
    throw new ApiError(400, 'invalid_relative_path', 'Choose a folder under the Worker workspace');
  }
}

// The online Worker that will run the command, with its workspace root.
function requireWorker(
  db: ApiContext['db'] | DbTransaction,
  registry: WorkerRegistry,
  workerId: string,
  capability: string,
): { workspaceRoot: string } {
  const worker = db.select().from(workers).where(eq(workers.id, workerId)).get();
  if (
    worker?.kind !== 'atlas' ||
    !worker.workspaceRoot ||
    !worker.capabilities.includes(capability) ||
    !registry.isOnline(workerId)
  ) {
    throw new ApiError(503, 'worker_unavailable', 'An online repository Worker is required');
  }
  return { workspaceRoot: worker.workspaceRoot };
}

// Writes a local project with its pending operation, and the link for a clone.
function insertLocalProject(
  context: ApiContext,
  registry: WorkerRegistry,
  name: string,
  repository: LocalCreate,
  createdBy: string | undefined,
  clone?: GithubRepository,
): ProjectCreateResponse {
  return context.db.transaction(
    (tx) => {
      const now = context.now();
      const { workerId, relativePath } = repository;
      const kind = clone ? REPOSITORY_CLONE_CAPABILITY : REPOSITORY_INIT_CAPABILITY;
      const worker = requireWorker(tx, registry, workerId, kind);
      const operation: Operation = {
        id: randomUUID(),
        projectId: randomUUID(),
        workerId,
        state: 'pending',
        connectionLost: false,
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      const project: Project = {
        id: operation.projectId,
        name,
        // The GitHub repository ID is a create-only field; the stored shape omits it.
        repository: { mode: 'local', workerId, relativePath, localPath: null },
        state: 'pending',
        operationId: operation.id,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(projects)
        .values({ ...project, createdBy: createdBy ?? null })
        .run();
      tx.insert(operations)
        .values({ ...operation, kind, workspaceRoot: worker.workspaceRoot })
        .run();
      if (clone) {
        tx.insert(githubLinks)
          .values({
            projectId: project.id,
            repositoryId: clone.id,
            fullName: clone.fullName,
            defaultBranch: clone.defaultBranch,
            createdBy: createdBy ?? null,
            createdAt: now,
          })
          .run();
      }
      return { project, operation };
    },
    { behavior: 'immediate' },
  );
}

// Confirms with GitHub, before anything is written, that the App can reach the repository.
async function confirmRepository(
  github: ProjectGithub,
  repositoryId: number,
): Promise<GithubRepository> {
  let secrets: ReturnType<AppFile['read']>;
  try {
    secrets = github.appFile.read();
  } catch {
    // The error names the file's path; the answer does not.
    throw new ApiError(502, 'github_unavailable', 'The GitHub App file is not readable');
  }
  if (!secrets) throw new ApiError(409, 'setup_required', 'Atlas is not set up yet');
  let found: Awaited<ReturnType<GitHubClient['getRepositoryById']>>;
  try {
    found = await github.client.getRepositoryById(secrets, repositoryId);
  } catch (error) {
    // GitHubError messages name the operation and outcome only.
    if (error instanceof GitHubError) throw new ApiError(502, 'github_unavailable', error.message);
    throw error;
  }
  if (!found) {
    throw new ApiError(
      403,
      'repository_not_accessible',
      'The GitHub App cannot access this repository',
    );
  }
  return found.repository;
}

async function createClonedProject(
  context: ApiContext,
  registry: WorkerRegistry,
  name: string,
  repository: LocalCreate & { githubRepositoryId: number },
  createdBy: string | undefined,
  github: ProjectGithub,
): Promise<ProjectCreateResponse> {
  assertRelativePath(repository.relativePath);
  // Checked before asking GitHub, and again in the transaction.
  requireWorker(context.db, registry, repository.workerId, REPOSITORY_CLONE_CAPABILITY);
  const clone = await confirmRepository(github, repository.githubRepositoryId);
  return insertLocalProject(context, registry, name, repository, createdBy, clone);
}

// Synchronous, except when a GitHub repository is to be cloned: that path asks GitHub first.
export function createProject(
  context: ApiContext,
  registry: WorkerRegistry,
  input: ProjectCreate,
  // The signed-in user, recorded in the database only; never part of a response.
  createdBy?: string,
  github?: ProjectGithub,
): ProjectCreateResponse | Promise<ProjectCreateResponse> {
  const { repository } = input;
  if (repository.mode === 'existing') {
    return context.db.transaction(
      (tx) => {
        const now = context.now();
        const project: Project = {
          id: randomUUID(),
          name: input.name,
          repository,
          state: 'ready',
          operationId: null,
          createdAt: now,
          updatedAt: now,
        };
        tx.insert(projects)
          .values({ ...project, createdBy: createdBy ?? null })
          .run();
        addVersion(tx, project.id, 'v0.1', now);
        return { project, operation: null };
      },
      { behavior: 'immediate' },
    );
  }
  const { githubRepositoryId } = repository;
  if (githubRepositoryId !== undefined && !github) {
    // With sign-in off there is no GitHub App to clone with; refuse instead of creating an empty repository.
    throw new ApiError(409, 'github_unavailable', 'GitHub is not available while sign-in is off');
  }
  if (githubRepositoryId !== undefined && github) {
    return createClonedProject(
      context,
      registry,
      input.name,
      { ...repository, githubRepositoryId },
      createdBy,
      github,
    );
  }
  assertRelativePath(repository.relativePath);
  return insertLocalProject(context, registry, input.name, repository, createdBy);
}
