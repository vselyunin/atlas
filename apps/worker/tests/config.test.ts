import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConfig } from '../src/config.js';
it('rejects a state directory inside the workspace even with a dot-prefixed name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-config-'));
  try {
    expect(() =>
      prepareConfig({
        root,
        stateDir: join(root, '..journal'),
        apiUrl: 'ws://127.0.0.1:4310/api/v1/workers/connect',
        id: 'atlas:test',
        name: 'Test',
        token: 'test-token',
      }),
    ).toThrow('outside');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
