import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.');
    throw new ApiError(
      400,
      'INVALID_INPUT',
      [field, issue?.message ?? 'Invalid input'].filter(Boolean).join(': '),
    );
  }
  return parsed.data;
}

export function registerErrorHandlers(app: FastifyInstance) {
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown route' } }),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request' } });
    }
    request.log.error({ requestId: request.id }, 'Unexpected API error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected API error' } });
  });
}
