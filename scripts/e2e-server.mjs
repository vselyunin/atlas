import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerListResponseSchema } from '../packages/contracts/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'atlas-e2e-'));
const env = {
  ...process.env,
  ATLAS_API_PORT: '4311',
  ATLAS_BOARD_ORIGIN: 'http://127.0.0.1:5174',
  ATLAS_DB_PATH: join(directory, 'db.sqlite'),
  ATLAS_WORKER_TOKEN: randomBytes(24).toString('hex'),
  ATLAS_API_WS_URL: 'ws://127.0.0.1:4311/api/v1/workers/connect',
  ATLAS_WORKER_ID: 'atlas:e2e',
  ATLAS_WORKER_NAME: 'Test Atlas worker',
  ATLAS_WORKSPACE_ROOT: join(directory, 'projects'),
  ATLAS_WORKER_STATE_DIR: join(directory, 'worker'),
  ATLAS_AUTH: 'off',
};
if (env.FORCE_COLOR !== undefined) delete env.NO_COLOR;
const children = [];
let stopping = false;
function launch(args) {
  // Shared process group lets the browser runner clean up the complete stack.
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  children.push(child);
  child.once('exit', (code) => {
    if (!stopping) void stop(code || 1);
  });
  child.once('error', () => {
    void stop(1);
  });
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  await Promise.all(
    children.map(
      (child) =>
        new Promise((done) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            done();
            return;
          }
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
          }, 10_000);
          child.once('exit', () => {
            clearTimeout(timer);
            done();
          });
          child.kill('SIGTERM');
        }),
    ),
  );
  await rm(directory, { recursive: true, force: true });
}
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
launch(['--import', 'tsx', 'apps/api/src/server.ts']);
launch(['--import', 'tsx', 'apps/worker/src/main.ts']);
const deadline = Date.now() + 60_000;
let ready = false;
while (!stopping && Date.now() < deadline) {
  try {
    const response = await fetch('http://127.0.0.1:4311/api/v1/workers', {
      signal: AbortSignal.timeout(1_000),
    });
    const body = WorkerListResponseSchema.parse(await response.json());
    ready = body.items.some(
      (worker) => worker.id === 'atlas:e2e' && worker.availability === 'online',
    );
    if (ready) break;
  } catch {
    /* API may still be loading. */
  }
  await delay(100);
}
if (!ready) {
  console.error('The test API and Worker did not become ready.');
  await stop(1);
} else if (!stopping) {
  const require = createRequire(import.meta.url);
  const vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  launch([vite, 'apps/board', '--host', '127.0.0.1', '--port', '5174']);
}
