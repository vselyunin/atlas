import {
  API_BASE_PATH,
  IdSchema,
  VersionCreateSchema,
  VersionListResponseSchema,
  VersionResponseSchema,
} from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../db/client.js';
import { parseInput } from '../http/errors.js';
import { createVersion, listVersions } from './service.js';

const ProjectParams = z.strictObject({ projectId: IdSchema });

export function registerVersionRoutes(app: FastifyInstance, context: ApiContext) {
  const route = `${API_BASE_PATH}/projects/:projectId/versions`;
  app.get(route, (request) => {
    const { projectId } = parseInput(ProjectParams, request.params);
    return VersionListResponseSchema.parse({ items: listVersions(context, projectId) });
  });
  app.post(route, (request, reply) => {
    const { projectId } = parseInput(ProjectParams, request.params);
    const version = createVersion(
      context,
      projectId,
      parseInput(VersionCreateSchema, request.body),
    );
    return reply.code(201).send(VersionResponseSchema.parse({ version }));
  });
}
