import {
  API_BASE_PATH,
  IdSchema,
  TaskCreateSchema,
  TaskListResponseSchema,
  TaskMoveSchema,
  TaskPatchSchema,
  TaskResponseSchema,
} from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../db/client.js';
import { parseInput } from '../http/errors.js';
import { createTask, listTasks, moveTask, patchTask } from './service.js';

const VersionParams = z.strictObject({ projectId: IdSchema, versionId: IdSchema });
const TaskParams = z.strictObject({ taskId: IdSchema });

export function registerTaskRoutes(app: FastifyInstance, context: ApiContext) {
  const scoped = `${API_BASE_PATH}/projects/:projectId/versions/:versionId/tasks`;
  app.get(scoped, (request) => {
    const { projectId, versionId } = parseInput(VersionParams, request.params);
    return TaskListResponseSchema.parse({ items: listTasks(context, projectId, versionId) });
  });
  app.post(scoped, (request, reply) => {
    const { projectId, versionId } = parseInput(VersionParams, request.params);
    const task = createTask(
      context,
      projectId,
      versionId,
      parseInput(TaskCreateSchema, request.body),
      request.user?.id,
    );
    return reply.code(201).send(TaskResponseSchema.parse({ task }));
  });
  app.patch(`${API_BASE_PATH}/tasks/:taskId`, (request) => {
    const { taskId } = parseInput(TaskParams, request.params);
    return TaskResponseSchema.parse({
      task: patchTask(context, taskId, parseInput(TaskPatchSchema, request.body)),
    });
  });
  app.post(`${API_BASE_PATH}/tasks/:taskId/move`, (request) => {
    const { taskId } = parseInput(TaskParams, request.params);
    return TaskResponseSchema.parse({
      task: moveTask(context, taskId, parseInput(TaskMoveSchema, request.body)),
    });
  });
}
