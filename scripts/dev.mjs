import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
let fileEnv = {};
try {
  fileEnv = parseEnv(await readFile(resolve(root, '.env'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const env = { ...fileEnv, ...process.env };
const stateRoot = resolve(root, '.atlas');
await mkdir(stateRoot, { recursive: true });
if (!env.ATLAS_WORKER_TOKEN) {
  const tokenPath = resolve(stateRoot, 'worker-token');
  try {
    env.ATLAS_WORKER_TOKEN = (await readFile(tokenPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    try {
      await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
    }
    env.ATLAS_WORKER_TOKEN = (await readFile(tokenPath, 'utf8')).trim();
  }
}
env.ATLAS_API_PORT ??= '4310';
env.ATLAS_BOARD_ORIGIN ??= 'http://localhost:5173';
env.ATLAS_DB_PATH = resolve(root, env.ATLAS_DB_PATH ?? '.atlas/atlas.sqlite');
env.ATLAS_API_WS_URL ??= `ws://127.0.0.1:${env.ATLAS_API_PORT}/api/v1/workers/connect`;
env.ATLAS_WORKER_ID ??= 'atlas:local';
env.ATLAS_WORKER_NAME ??= 'Local Atlas worker';
env.ATLAS_WORKSPACE_ROOT = resolve(root, env.ATLAS_WORKSPACE_ROOT ?? '.atlas/projects');
env.ATLAS_WORKER_STATE_DIR = resolve(root, env.ATLAS_WORKER_STATE_DIR ?? '.atlas/worker');

const build = spawnSync('pnpm', ['--filter', '@atlas/contracts', 'build'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') console.error(error.message);
      }
    }
  }
  const forced = setTimeout(() => {
    for (const child of children) {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') console.error(error.message);
        }
      }
    }
  }, 10_000);
  forced.unref();
}

for (const name of ['api', 'worker', 'board']) {
  const child = spawn('pnpm', ['--filter', `@atlas/${name}`, 'dev'], {
    cwd: root,
    env,
    stdio: 'inherit',
    detached: true,
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(`Could not start ${name}: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${name} stopped (${signal ?? code}); stopping Atlas.`);
      stop(code || 1);
    }
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log(`Atlas Board: ${env.ATLAS_BOARD_ORIGIN}`);
console.log(`Repository workspace: ${env.ATLAS_WORKSPACE_ROOT}`);
console.log('Press Ctrl+C to stop all three apps. Your data will be preserved.');
