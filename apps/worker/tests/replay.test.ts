import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { WorkerToApiMessageSchema, makeRepositoryInitCommandFixture } from '@atlas/contracts';
import type { CommandResult } from '@atlas/contracts';
import { startWorker } from '../src/main.js';
import { Journal } from '../src/state/journal.js';

it('replays an unacknowledged result after disconnect without recreating the repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-replay-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const command = makeRepositoryInitCommandFixture({ commandId: randomUUID() });
  const results: CommandResult[] = [];
  let registrations = 0;
  server.on('connection', (socket) => {
    socket.on('message', (data: Buffer) => {
      const message = WorkerToApiMessageSchema.parse(JSON.parse(data.toString('utf8')));
      if (message.type === 'worker.register') {
        registrations++;
        socket.send(
          JSON.stringify({
            protocolVersion: 1,
            messageId: randomUUID(),
            type: 'worker.registered',
            payload: { workerId: message.payload.workerId, heartbeatIntervalMs: 10000 },
          }),
        );
        if (registrations === 1) socket.send(JSON.stringify(command));
      } else if (message.type === 'command.result') {
        results.push(message);
        if (results.length === 1) socket.terminate();
        else
          socket.send(
            JSON.stringify({
              protocolVersion: 1,
              messageId: randomUUID(),
              type: 'command.result_ack',
              commandId: message.commandId,
              payload: {},
            }),
          );
      }
    });
  });
  const stateDir = join(directory, 'state');
  const root = join(directory, 'repositories');
  const worker = startWorker({
    apiUrl: `ws://127.0.0.1:${address.port}`,
    token: 'test-token',
    id: 'atlas:replay',
    name: 'Replay',
    root,
    stateDir,
  });
  try {
    await expect.poll(() => results.length, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
    expect(results[0]?.payload).toEqual({ status: 'succeeded', localPath: join(root, 'project') });
    expect(results[1]?.payload).toEqual(results[0]?.payload);
    expect(registrations).toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => new Journal(stateDir).get(command.commandId)?.acknowledged, { timeout: 3000 })
      .toBe(true);
    expect((await stat(join(root, 'project', '.git'))).isDirectory()).toBe(true);
  } finally {
    await worker.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
