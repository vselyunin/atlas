import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { ApiOptions } from '../../src/app.js';

export const BOARD_ORIGIN = 'http://localhost:5173';
export const WORKER_TOKEN = 'test-token';

// An App file in the shape the API stores after setup; written by hand until Task 4.
export const TEST_APP_SECRETS = {
  appId: 1,
  slug: 'atlas-test',
  name: 'Atlas test',
  account: 'octo',
  clientId: 'Iv1.test',
  clientSecret: 'secret',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n',
};

// Builds the API with sign-in on, a database and an App file path in a temporary directory.
// The App file is not created; tests that need setup done write it themselves.
export async function buildAuthApp(overrides: Partial<ApiOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-auth-'));
  const appFile = join(directory, 'github-app.json');
  const ownerCodes: string[] = [];
  let app: FastifyInstance;
  try {
    app = await buildApp({
      dbPath: join(directory, 'atlas.sqlite'),
      workerToken: WORKER_TOKEN,
      allowedOrigin: BOARD_ORIGIN,
      ...overrides,
      auth: {
        appFile,
        ownerCodeSink: (code) => ownerCodes.push(code),
        ...overrides.auth,
      },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    app,
    appFile,
    directory,
    ownerCodes,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
