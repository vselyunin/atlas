import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  buildImage,
  ensureDocker,
  hostGitIdentity,
  runArgs,
  runCommand,
  serviceFacts,
} from './worker-container.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = process.argv.slice(2);
if (options.some((option) => option !== '--web')) {
  console.error('Usage: node scripts/dev.mjs [--web]');
  process.exit(2);
}
const web = options.includes('--web');
const containerName = 'atlas-worker';
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

if (!web) {
  try {
    await ensureDocker({
      run: runCommand,
      ...serviceFacts(),
      log: (message) => console.log(message),
    });
    await buildImage({ run: runCommand, repoRoot: root });
    if (!env.ATLAS_AGENT_GIT_NAME || !env.ATLAS_AGENT_GIT_EMAIL) {
      const identity = await hostGitIdentity({
        run: (command, args) => runCommand(command, args, { cwd: root }),
      });
      env.ATLAS_AGENT_GIT_NAME ||= identity.name;
      env.ATLAS_AGENT_GIT_EMAIL ||= identity.email;
    }
    // Docker would create missing bind-mount sources as root-owned directories.
    await mkdir(env.ATLAS_WORKSPACE_ROOT, { recursive: true });
    await mkdir(env.ATLAS_WORKER_STATE_DIR, { recursive: true });
    // A container left behind by a crash would hold the name; let its Worker release its lock.
    await runCommand('docker', ['stop', '-t', '10', containerName]);
    await runCommand('docker', ['rm', '-f', containerName]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const build = spawnSync('pnpm', ['--filter', '@atlas/contracts', 'build'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [];
let worker;
let stopping = false;
// Runs once the docker client has exited, so the Worker has had its chance to stop cleanly.
function removeContainer() {
  void runCommand('docker', ['rm', '-f', containerName]);
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (worker) {
    if (!worker.pid || worker.exitCode !== null || worker.signalCode !== null) removeContainer();
    else worker.once('exit', removeContainer);
  }
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

const apps = [
  { name: 'api', command: 'pnpm', args: ['--filter', '@atlas/api', 'dev'] },
  ...(web
    ? []
    : [
        {
          name: 'worker',
          command: 'docker',
          args: runArgs({ name: containerName, env, repoRoot: root }),
        },
      ]),
  { name: 'board', command: 'pnpm', args: ['--filter', '@atlas/board', 'dev'] },
];
for (const { name, command, args } of apps) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    detached: true,
  });
  children.push(child);
  if (name === 'worker') worker = child;
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
// A closed terminal sends SIGHUP; the detached children would not receive it.
process.on('SIGHUP', () => stop());
console.log(`Atlas Board: ${env.ATLAS_BOARD_ORIGIN}`);
console.log(`Repository workspace: ${env.ATLAS_WORKSPACE_ROOT}`);
console.log(
  web
    ? 'Press Ctrl+C to stop the API and Board. No Worker is running.'
    : 'Press Ctrl+C to stop all three apps. Your data will be preserved.',
);
