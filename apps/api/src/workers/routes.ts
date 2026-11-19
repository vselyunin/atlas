import { API_BASE_PATH, WorkerListResponseSchema } from '@atlas/contracts';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../db/client.js';
import { workers } from '../db/schema.js';

export function registerWorkerRoutes(app: FastifyInstance, { db }: ApiContext) {
  app.get(`${API_BASE_PATH}/workers`, () =>
    WorkerListResponseSchema.parse({
      items: db
        .select()
        .from(workers)
        .orderBy(asc(workers.kind), asc(workers.name), asc(workers.id))
        .all(),
    }),
  );
}
