import { OperationSchema, ProjectSchema } from './projects.js';
import type { Operation, Project } from './projects.js';
import {
  CommandResultSchema,
  PROTOCOL_VERSION,
  RepositoryCloneCommandSchema,
  RepositoryInitCommandSchema,
} from './protocol.js';
import type { CommandResult, RepositoryCloneCommand, RepositoryInitCommand } from './protocol.js';
import { TaskSchema } from './tasks.js';
import type { Task } from './tasks.js';
import { VersionSchema } from './versions.js';
import type { Version } from './versions.js';
import {
  HUMAN_WORKER_ID,
  REPOSITORY_CLONE_CAPABILITY,
  REPOSITORY_INIT_CAPABILITY,
  WorkerSchema,
} from './workers.js';
import type { Worker } from './workers.js';

const timestamp = '2026-11-19T00:00:00.000Z';

export function makeProjectFixture(overrides: Partial<Project> = {}): Project {
  return ProjectSchema.parse({
    id: 'project:example',
    name: 'Example project',
    repository: { mode: 'existing', gitUrl: 'https://example.com/team/project.git' },
    state: 'ready',
    operationId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

export function makeVersionFixture(overrides: Partial<Version> = {}): Version {
  return VersionSchema.parse({
    id: 'version:example',
    projectId: 'project:example',
    name: 'v0.1',
    createdAt: timestamp,
    ...overrides,
  });
}

export function makeTaskFixture(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: 'task:example',
    projectId: 'project:example',
    versionId: 'version:example',
    title: 'Example task',
    description: '',
    status: 'backlog',
    type: 'task',
    priority: 'medium',
    assigneeId: null,
    position: 0,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

export function makeWorkerFixture(overrides: Partial<Worker> = {}): Worker {
  return WorkerSchema.parse({
    id: 'atlas:example',
    name: 'Atlas',
    kind: 'atlas',
    availability: 'online',
    lastSeenAt: timestamp,
    workspaceRoot: '/workspace',
    capabilities: [REPOSITORY_INIT_CAPABILITY],
    ...overrides,
  });
}

export function makeHumanWorkerFixture(): Worker {
  return WorkerSchema.parse({
    id: HUMAN_WORKER_ID,
    name: 'Vladi',
    kind: 'human',
    availability: 'not_applicable',
    lastSeenAt: null,
    workspaceRoot: null,
    capabilities: [],
  });
}

export function makeOperationFixture(overrides: Partial<Operation> = {}): Operation {
  return OperationSchema.parse({
    id: 'operation:example',
    projectId: 'project:example',
    workerId: 'atlas:example',
    state: 'pending',
    connectionLost: false,
    result: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

export function makeRepositoryInitCommandFixture(
  overrides: Partial<RepositoryInitCommand> = {},
): RepositoryInitCommand {
  return RepositoryInitCommandSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'message:dispatch',
    type: 'command.dispatch',
    commandId: 'operation:example',
    payload: {
      kind: REPOSITORY_INIT_CAPABILITY,
      projectId: 'project:example',
      relativePath: 'project',
    },
    ...overrides,
  });
}

export function makeRepositoryCloneCommandFixture(
  overrides: Partial<RepositoryCloneCommand> = {},
): RepositoryCloneCommand {
  return RepositoryCloneCommandSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'message:dispatch',
    type: 'command.dispatch',
    commandId: 'operation:example',
    payload: {
      kind: REPOSITORY_CLONE_CAPABILITY,
      projectId: 'project:example',
      relativePath: 'project',
      repository: 'team/project',
    },
    ...overrides,
  });
}

export function makeCommandResultFixture(overrides: Partial<CommandResult> = {}): CommandResult {
  return CommandResultSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'message:result',
    type: 'command.result',
    commandId: 'operation:example',
    payload: { status: 'succeeded', localPath: '/workspace/project' },
    ...overrides,
  });
}
