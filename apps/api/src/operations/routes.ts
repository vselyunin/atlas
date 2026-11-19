import { API_BASE_PATH, IdSchema, OperationResponseSchema } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../db/client.js';
import { parseInput } from '../http/errors.js';
import { getOperation } from './service.js';

export function registerOperationRoutes(app: FastifyInstance, context: ApiContext) {
  app.get(`${API_BASE_PATH}/operations/:operationId`, (request) => {
    const { operationId } = parseInput(z.strictObject({ operationId: IdSchema }), request.params);
    return OperationResponseSchema.parse({ operation: getOperation(context, operationId) });
  });
}
