import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atlas-api-'));
  app = await buildApp({
    dbPath: join(directory, 'db.sqlite'),
    workerToken: 'test-token',
    allowedOrigin: 'http://localhost:5173',
  });
});
afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

it.each(['.atlas-worktrees/x', '.hidden'])(
  'refuses a local project path starting with a dot: %s',
  async (relativePath) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: {
        name: 'Example',
        repository: { mode: 'local', workerId: 'atlas:test', relativePath },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_relative_path');
  },
);
