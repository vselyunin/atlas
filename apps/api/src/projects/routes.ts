import {
  API_BASE_PATH,
  IdSchema,
  ProjectCreateResponseSchema,
  ProjectCreateSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
} from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../db/client.js';
import type { CredentialBroker } from '../github/credentials.js';
import { parseInput } from '../http/errors.js';
import { dispatchPending, getOperation } from '../operations/service.js';
import type { WorkerRegistry } from '../workers/registry.js';
import { createProject, getProject, listProjects } from './service.js';
import type { ProjectGithub } from './service.js';

export function registerProjectRoutes(
  app: FastifyInstance,
  context: ApiContext,
  registry: WorkerRegistry,
  broker: CredentialBroker,
  github?: ProjectGithub,
) {
  app.get(`${API_BASE_PATH}/projects`, () =>
    ProjectListResponseSchema.parse({ items: listProjects(context) }),
  );
  app.get(`${API_BASE_PATH}/projects/:projectId`, (request) => {
    const { projectId } = parseInput(z.strictObject({ projectId: IdSchema }), request.params);
    return ProjectResponseSchema.parse({ project: getProject(context.db, projectId) });
  });
  app.post(`${API_BASE_PATH}/projects`, async (request, reply) => {
    const { project, operation } = await createProject(
      context,
      registry,
      parseInput(ProjectCreateSchema, request.body),
      request.user?.id,
      github,
    );
    if (operation) dispatchPending(context, registry, operation.workerId, operation.id, broker);
    return reply.code(operation ? 202 : 201).send(
      ProjectCreateResponseSchema.parse({
        project,
        operation: operation ? getOperation(context, operation.id) : null,
      }),
    );
  });
}
