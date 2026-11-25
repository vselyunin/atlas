import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export const IMAGE = 'atlas-worker:dev';
export const HOME_VOLUME = 'atlas-agent-home';

const requiredVariables = [
  'ATLAS_API_WS_URL',
  'ATLAS_WORKER_TOKEN',
  'ATLAS_WORKER_ID',
  'ATLAS_WORKER_NAME',
  'ATLAS_WORKSPACE_ROOT',
  'ATLAS_WORKER_STATE_DIR',
];
const optionalVariables = [
  'ATLAS_AGENT_COMMAND',
  'ATLAS_AGENT_SANDBOX',
  'ATLAS_AGENT_ALLOWED_DOMAINS',
  'ATLAS_AGENT_GIT_NAME',
  'ATLAS_AGENT_GIT_EMAIL',
  'ATLAS_GIT_HOST_URL',
];
const dockerStartTimeout = 20_000;
const dockerPollInterval = 500;

/**
 * Runs a command and resolves with its exit code (null when it could not start) and its standard
 * output. `stdio: 'inherit'` streams output to the terminal; `logFile` starts it detached with its
 * output appended to that file and resolves once it has started.
 */
export function runCommand(command, args, { cwd, env, stdio = 'pipe', logFile } = {}) {
  return new Promise((resolve) => {
    if (logFile) {
      let fd;
      try {
        fd = openSync(logFile, 'a');
      } catch {
        resolve({ code: null, stdout: '' });
        return;
      }
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
      closeSync(fd);
      child.on('error', () => resolve({ code: null, stdout: '' }));
      child.on('spawn', () => {
        child.unref();
        resolve({ code: 0, stdout: '' });
      });
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.on('error', () => resolve({ code: null, stdout }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/** Whether this process may start the Docker service itself. */
export function serviceFacts() {
  return { isRoot: process.getuid?.() === 0, hasSystemd: existsSync('/run/systemd/system') };
}

/** Arguments after `docker` that start the Worker container. Variables are passed by name only. */
export function runArgs({ name, env, repoRoot }) {
  const workspace = env.ATLAS_WORKSPACE_ROOT;
  const stateDir = env.ATLAS_WORKER_STATE_DIR;
  const variables = [
    ...requiredVariables,
    ...optionalVariables.filter((variable) => env[variable] !== undefined),
  ];
  return [
    'run',
    '--rm',
    '--init',
    '--name',
    name,
    '--network',
    'host',
    '--security-opt',
    `seccomp=${repoRoot.replace(/\/$/, '')}/docker/worker/seccomp.json`,
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '-v',
    `${workspace}:${workspace}`,
    '-v',
    `${stateDir}:${stateDir}`,
    '-v',
    `${HOME_VOLUME}:/home/atlas`,
    ...variables.flatMap((variable) => ['-e', variable]),
    IMAGE,
  ];
}

/** Makes sure Docker is installed and its service answers, starting `dockerd` when it can. */
export async function ensureDocker({ run, isRoot, hasSystemd, log }) {
  if ((await run('docker', ['--version'])).code !== 0)
    throw new Error('Docker is not installed. See docs/development/local-setup.md.');
  if ((await run('docker', ['info'])).code === 0) return;
  if (!isRoot || hasSystemd)
    throw new Error('The Docker service is not running. Start it and run the command again.');

  log('Starting the Docker service (log: /var/log/dockerd.log).');
  if ((await run('dockerd', [], { logFile: '/var/log/dockerd.log' })).code !== 0)
    throw new Error('Could not start the Docker service. See /var/log/dockerd.log.');
  const deadline = Date.now() + dockerStartTimeout;
  for (;;) {
    if ((await run('docker', ['info'])).code === 0) return;
    if (Date.now() >= deadline)
      throw new Error(
        'The Docker service did not start within 20 seconds. See /var/log/dockerd.log.',
      );
    await sleep(dockerPollInterval);
  }
}

/** Builds the Worker image, streaming the build output. Docker's cache keeps a rebuild fast. */
export async function buildImage({ run, repoRoot }) {
  const result = await run(
    'docker',
    ['build', '-f', 'docker/worker/Dockerfile', '-t', IMAGE, '.'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    },
  );
  if (result.code !== 0) throw new Error(`Could not build the Worker image ${IMAGE}.`);
}

/** The host user's Git name and email, or nothing unless both are set. */
export async function hostGitIdentity({ run }) {
  const name = await run('git', ['config', 'user.name']);
  const email = await run('git', ['config', 'user.email']);
  const nameValue = name.stdout.trim();
  const emailValue = email.stdout.trim();
  if (name.code !== 0 || email.code !== 0 || !nameValue || !emailValue) return {};
  return { name: nameValue, email: emailValue };
}
