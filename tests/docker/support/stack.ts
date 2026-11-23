import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chown, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildApp } from '../../../apps/api/src/app.js';
import {
  ApiToBoardSessionMessageSchema,
  ProjectCreateResponseSchema,
  TaskResponseSchema,
  VersionListResponseSchema,
  WorkerListResponseSchema,
} from '../../../packages/contracts/src/index.js';
import type { ApiToBoardSessionMessage, Worker } from '../../../packages/contracts/src/index.js';
import type { RunOptions, RunResult } from '../../../scripts/worker-container.mjs';
import {
  HOME_VOLUME,
  IMAGE,
  buildImage,
  ensureDocker,
  runArgs,
  runCommand,
  serviceFacts,
} from '../../../scripts/worker-container.mjs';

const execute = promisify(execFile);

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
export const fixtures = join(repoRoot, 'tests/docker/fixtures');
// The stand-in agent of the Worker tests, mounted read-only into the container.
export const echoAgent = join(repoRoot, 'apps/worker/tests/fixtures/agent.mjs');

export const AGENT_GIT_NAME = 'Atlas Docker Test';
export const AGENT_GIT_EMAIL = 'docker-test@atlas.invalid';
// The Worker runs as this user in the container.
const CONTAINER_UID = 1001;
const WORKER_TOKEN = 'docker-test-token';
const ORIGIN = 'http://localhost:5173';
const START_TIMEOUT_MS = 60_000;

type App = Awaited<ReturnType<typeof buildApp>>;

// Records every frame a Board socket receives, from the moment it opens.
export class Board {
  readonly messages: ApiToBoardSessionMessage[] = [];
  constructor(private readonly socket: { send(data: string): void }) {}
  get output() {
    return this.outputFrom(0);
  }
  // The output received from message index `start` on, for example after a restart.
  outputFrom(start: number) {
    return this.messages
      .slice(start)
      .flatMap((m) => (m.type === 'output' ? [m.data] : []))
      .join('');
  }
  get states() {
    return this.messages.flatMap((m) => (m.type === 'session' ? [m.state] : []));
  }
  get session() {
    return this.messages.filter((m) => m.type === 'session').at(-1);
  }
  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }
}

export interface StackOptions {
  seccomp?: 'narrow' | 'default';
  // The agent command; a function receives the stack's paths, which exist only once it starts.
  agent?: string[] | ((paths: { workspace: string; stateDir: string }) => string[]);
  extraDomains?: string[];
}

export interface Stack {
  api: App;
  workerId: string;
  containerName: string;
  workspace: string;
  stateDir: string;
  boardSocket(taskId: string): Promise<Board>;
  createLocalTask(
    relativePath: string,
    title: string,
    description?: string,
  ): Promise<{ taskId: string }>;
  // Runs a command in the Worker container and resolves with its exit code.
  exec(args: string[]): Promise<number>;
  logs(): string;
  stop(): Promise<void>;
}

let imageReady: Promise<void> | undefined;
const BUILD_LOCK = join(tmpdir(), 'atlas-docker-test-build.lock');

// Runs a command without streaming it, keeping all of its output for an error message.
function quietRunner() {
  let output = '';
  const run = (command: string, args: string[], options: RunOptions = {}): Promise<RunResult> =>
    // A detached service with a log file, such as dockerd, keeps the shared behavior.
    options.logFile
      ? runCommand(command, args, options)
      : new Promise<RunResult>((resolve) => {
          const child = spawn(command, args, { cwd: options.cwd, env: options.env });
          let stdout = '';
          child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
            output += chunk;
          });
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
          child.on('error', () => resolve({ code: null, stdout }));
          child.on('close', (code) => resolve({ code, stdout }));
        });
  return { run, output: () => output };
}

// Test files run in parallel, and two builds of one tag at once can fail, so builds take turns.
async function withBuildLock(action: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try {
      await writeFile(BUILD_LOCK, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
    }
    const holder = Number(await readFile(BUILD_LOCK, 'utf8').catch(() => ''));
    if (holder > 0 && !isRunning(holder)) await rm(BUILD_LOCK, { force: true });
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${BUILD_LOCK}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  try {
    await action();
  } finally {
    await rm(BUILD_LOCK, { force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Builds the image once per test file; Docker's cache makes a repeat build fast.
export function prepareImage(): Promise<void> {
  imageReady ??= withBuildLock(async () => {
    const { run, output } = quietRunner();
    try {
      await ensureDocker({ run, ...serviceFacts(), log: () => {} });
      await buildImage({ run, repoRoot });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n${output().slice(-4000)}`, { cause: error });
    }
  });
  return imageReady;
}

async function docker(args: string[]): Promise<number> {
  try {
    await execute('docker', args, { timeout: 60_000 });
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' ? code : -1;
  }
}

async function waitFor<T>(
  description: string,
  check: () => Promise<T | undefined> | T | undefined,
  details: () => string,
): Promise<T> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`${description} timed out.\n${details()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Replaces the login volume and seccomp option of the real arguments and adds read-only fixtures.
function containerArgs(
  args: string[],
  input: { homeVolume: string; seccomp: 'narrow' | 'default'; readOnly: string[] },
): string[] {
  const result = [...args];
  const home = result.indexOf(`${HOME_VOLUME}:/home/atlas`);
  if (home === -1 || result.at(-1) !== IMAGE) {
    throw new Error('runArgs changed shape; update tests/docker/support/stack.ts');
  }
  // The real login volume is never mounted by tests.
  result[home] = `${input.homeVolume}:/home/atlas`;
  if (input.seccomp === 'default') {
    const seccomp = result.findIndex((arg) => arg.startsWith('seccomp='));
    if (seccomp < 1 || result[seccomp - 1] !== '--security-opt') {
      throw new Error('runArgs has no seccomp option; update tests/docker/support/stack.ts');
    }
    result.splice(seccomp - 1, 2);
  }
  const mounts = input.readOnly.flatMap((path) => ['-v', `${path}:${path}:ro`]);
  result.splice(result.length - 1, 0, ...mounts);
  return result;
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  await prepareImage();
  const id = randomBytes(4).toString('hex');
  const containerName = `atlas-test-worker-${id}`;
  const homeVolume = `atlas-test-home-${id}`;
  const workerId = `atlas:docker-test-${id}`;
  // Siblings, so the state directory is outside the workspace; both are mounted at these paths.
  const base = await mkdtemp(join(tmpdir(), 'atlas-docker-'));
  const workspace = join(base, 'workspace');
  const stateDir = join(base, 'state');
  const sockets: { terminate(): void }[] = [];
  let api: App | undefined;
  let container: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> = Promise.resolve();
  let volumeCreated = false;
  let log = '';

  const stop = async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    if (container) {
      await docker(['stop', '-t', '10', containerName]);
      await docker(['rm', '-f', containerName]);
      await exited;
    }
    if (volumeCreated) await docker(['volume', 'rm', '-f', homeVolume]);
    await api?.close();
    await rm(base, { recursive: true, force: true });
  };

  try {
    for (const directory of [workspace, stateDir]) {
      await mkdir(directory);
      await chown(directory, CONTAINER_UID, CONTAINER_UID);
    }
    if ((await docker(['volume', 'create', homeVolume])) !== 0) {
      throw new Error(`Could not create the Docker volume ${homeVolume}`);
    }
    volumeCreated = true;

    api = await buildApp({
      dbPath: join(base, 'api.sqlite'),
      workerToken: WORKER_TOKEN,
      allowedOrigin: ORIGIN,
    });
    const address = await api.listen({ host: '127.0.0.1', port: 0 });

    const agent =
      typeof options.agent === 'function'
        ? options.agent({ workspace, stateDir })
        : (options.agent ?? ['node', echoAgent]);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ATLAS_API_WS_URL: `${address.replace('http:', 'ws:')}/api/v1/workers/connect`,
      ATLAS_WORKER_TOKEN: WORKER_TOKEN,
      ATLAS_WORKER_ID: workerId,
      ATLAS_WORKER_NAME: `Docker test worker ${id}`,
      ATLAS_WORKSPACE_ROOT: workspace,
      ATLAS_WORKER_STATE_DIR: stateDir,
      ATLAS_AGENT_COMMAND: agent.join(' '),
      ATLAS_AGENT_SANDBOX: 'required',
      ATLAS_AGENT_ALLOWED_DOMAINS: (options.extraDomains ?? []).join(','),
      ATLAS_AGENT_GIT_NAME: AGENT_GIT_NAME,
      ATLAS_AGENT_GIT_EMAIL: AGENT_GIT_EMAIL,
    };
    const args = containerArgs(runArgs({ name: containerName, env, repoRoot }), {
      homeVolume,
      seccomp: options.seccomp ?? 'narrow',
      readOnly: [fixtures, echoAgent],
    });
    const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    container = child;
    exited = new Promise((resolve) => child.once('close', () => resolve()));
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (log += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (log += chunk));

    const app = api;
    await waitFor(
      'Waiting for the container Worker to come online',
      async () => {
        const workers = WorkerListResponseSchema.parse(
          (await app.inject('/api/v1/workers')).json<unknown>(),
        ).items;
        return workers.find(
          (worker: Worker) => worker.id === workerId && worker.availability === 'online',
        );
      },
      () => `Container output:\n${log}`,
    );
  } catch (error) {
    await stop();
    throw error;
  }

  const app = api;
  const projects = new Map<string, { projectId: string; versionId: string }>();

  const project = async (relativePath: string) => {
    const known = projects.get(relativePath);
    if (known) return known;
    const created = ProjectCreateResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects',
          payload: { name: relativePath, repository: { mode: 'local', workerId, relativePath } },
        })
      ).json<unknown>(),
    );
    const projectId = created.project.id;
    // The Worker creates the first version once it has initialized the repository.
    const versionId = await waitFor(
      `Waiting for the Worker to initialize ${relativePath}`,
      async () =>
        VersionListResponseSchema.parse(
          (await app.inject(`/api/v1/projects/${projectId}/versions`)).json<unknown>(),
        ).items[0]?.id,
      () => `Container output:\n${log}`,
    );
    const entry = { projectId, versionId };
    projects.set(relativePath, entry);
    return entry;
  };

  return {
    api: app,
    workerId,
    containerName,
    workspace,
    stateDir,
    async boardSocket(taskId) {
      let board: Board | undefined;
      const socket = await app.injectWS(
        `/api/v1/tasks/${taskId}/session`,
        { headers: { host: 'localhost', origin: ORIGIN } },
        {
          onInit: (ws) => {
            const opened = new Board(ws);
            board = opened;
            ws.on('message', (data: Buffer) => {
              opened.messages.push(
                ApiToBoardSessionMessageSchema.parse(JSON.parse(data.toString('utf8'))),
              );
            });
          },
        },
      );
      sockets.push(socket);
      if (!board) throw new Error('The Board socket did not open');
      return board;
    },
    async createLocalTask(relativePath, title, description) {
      const { projectId, versionId } = await project(relativePath);
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/versions/${versionId}/tasks`,
        payload: description === undefined ? { title } : { title, description },
      });
      return { taskId: TaskResponseSchema.parse(response.json<unknown>()).task.id };
    },
    exec: (command) => docker(['exec', containerName, ...command]),
    logs: () => log,
    stop,
  };
}

// The `PROBE` lines of a session's output, by name.
export function probeResults(output: string): Map<string, string> {
  const results = new Map<string, string>();
  for (const match of output.replaceAll('\r', '').matchAll(/^PROBE (\S+) (.*)$/gm)) {
    const [, name = '', value = ''] = match;
    results.set(name, value);
  }
  return results;
}
