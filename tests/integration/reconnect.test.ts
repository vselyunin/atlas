import { expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/api/src/app.js';
import { startWorker } from '../../apps/worker/src/main.js';
import {
  WorkerListResponseSchema,
  ProjectCreateResponseSchema,
  OperationResponseSchema,
  VersionListResponseSchema,
} from '../../packages/contracts/src/index.js';

it('creates a real repository and reconnects the same worker after API restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-integration-'));
  const options = {
    dbPath: join(directory, 'db.sqlite'),
    workerToken: 'integration-token',
    allowedOrigin: 'http://localhost:5173',
  };
  let app = await buildApp(options);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(new URL(address).port);
  const worker = startWorker({
    apiUrl: address.replace('http:', 'ws:') + '/api/v1/workers/connect',
    token: options.workerToken,
    id: 'atlas:integration',
    name: 'Integration worker',
    root: join(directory, 'repos'),
    stateDir: join(directory, 'state'),
  });
  try {
    const online = async () =>
      WorkerListResponseSchema.parse(
        (await app.inject('/api/v1/workers')).json<unknown>(),
      ).items.filter((item) => item.availability === 'online').length;
    await expect.poll(online, { timeout: 10000 }).toBe(1);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: {
        name: 'Local',
        repository: { mode: 'local', workerId: 'atlas:integration', relativePath: 'created' },
      },
    });
    expect(create.statusCode).toBe(202);
    const result = ProjectCreateResponseSchema.parse(create.json<unknown>());
    const operationId = result.operation?.id;
    if (!operationId) throw new Error('Missing operation');
    const state = async () =>
      OperationResponseSchema.parse(
        (await app.inject(`/api/v1/operations/${operationId}`)).json<unknown>(),
      ).operation.state;
    await expect.poll(state, { timeout: 10000 }).toBe('succeeded');
    const original = await stat(join(directory, 'repos', 'created'));
    await app.close();
    app = await buildApp(options);
    expect(await online()).toBe(0);
    await app.listen({ host: '127.0.0.1', port });
    await expect.poll(online, { timeout: 10000 }).toBe(1);
    expect(await state()).toBe('succeeded');
    expect((await stat(join(directory, 'repos', 'created'))).ino).toBe(original.ino);
    expect(
      VersionListResponseSchema.parse(
        (await app.inject(`/api/v1/projects/${result.project.id}/versions`)).json<unknown>(),
      ).items,
    ).toHaveLength(1);
  } finally {
    await worker.stop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
