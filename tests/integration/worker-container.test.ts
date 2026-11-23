import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../scripts/worker-container.mjs';
import { ensureDocker, hostGitIdentity, runArgs } from '../../scripts/worker-container.mjs';

const repoRoot = '/home/me/atlas';
const workspace = '/mnt/c/Users/me/My Projects/atlas/.atlas/projects';
const stateDir = '/mnt/c/Users/me/My Projects/atlas/.atlas/worker';
const token = 'secret-token-value';
const requiredEnv = {
  ATLAS_API_WS_URL: 'ws://127.0.0.1:4310/api/v1/workers/connect',
  ATLAS_WORKER_TOKEN: token,
  ATLAS_WORKER_ID: 'atlas:local',
  ATLAS_WORKER_NAME: 'Local Atlas worker',
  ATLAS_WORKSPACE_ROOT: workspace,
  ATLAS_WORKER_STATE_DIR: stateDir,
};

type Call = { command: string; args: string[] };

function runner(answer: (call: Call) => RunResult) {
  const calls: Call[] = [];
  const run = (command: string, args: string[]) => {
    const call = { command, args };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { run, calls };
}

const ok = { code: 0, stdout: '' };
const failed = { code: 1, stdout: '' };

describe('runArgs', () => {
  it('returns the exact docker run arguments with every optional variable set', () => {
    const env = {
      ...requiredEnv,
      ATLAS_AGENT_COMMAND: 'claude',
      ATLAS_AGENT_SANDBOX: 'required',
      ATLAS_AGENT_ALLOWED_DOMAINS: 'registry.npmjs.org',
      ATLAS_AGENT_GIT_NAME: 'Ada Lovelace',
      ATLAS_AGENT_GIT_EMAIL: 'ada@example.com',
      UNRELATED: 'ignored',
    };
    expect(runArgs({ name: 'atlas-worker', env, repoRoot })).toEqual([
      'run',
      '--rm',
      '--init',
      '--name',
      'atlas-worker',
      '--network',
      'host',
      '--security-opt',
      'seccomp=/home/me/atlas/docker/worker/seccomp.json',
      '-v',
      `${workspace}:${workspace}`,
      '-v',
      `${stateDir}:${stateDir}`,
      '-v',
      'atlas-agent-home:/home/atlas',
      '-e',
      'ATLAS_API_WS_URL',
      '-e',
      'ATLAS_WORKER_TOKEN',
      '-e',
      'ATLAS_WORKER_ID',
      '-e',
      'ATLAS_WORKER_NAME',
      '-e',
      'ATLAS_WORKSPACE_ROOT',
      '-e',
      'ATLAS_WORKER_STATE_DIR',
      '-e',
      'ATLAS_AGENT_COMMAND',
      '-e',
      'ATLAS_AGENT_SANDBOX',
      '-e',
      'ATLAS_AGENT_ALLOWED_DOMAINS',
      '-e',
      'ATLAS_AGENT_GIT_NAME',
      '-e',
      'ATLAS_AGENT_GIT_EMAIL',
      'atlas-worker:dev',
    ]);
  });

  it('keeps a workspace path with a space as one volume value', () => {
    const args = runArgs({ name: 'atlas-worker', env: requiredEnv, repoRoot });
    expect(args).toContain(`${workspace}:${workspace}`);
    expect(args.filter((arg) => arg === '-v')).toHaveLength(3);
  });

  it('adds no privileges and no Docker socket', () => {
    const args = runArgs({ name: 'atlas-worker', env: requiredEnv, repoRoot });
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--cap-add');
    expect(args.some((arg) => arg.includes('docker.sock'))).toBe(false);
  });

  it('omits unset optional variables and never contains a value', () => {
    const args = runArgs({ name: 'atlas-worker', env: requiredEnv, repoRoot });
    expect(args.filter((arg) => arg.startsWith('ATLAS_AGENT_'))).toEqual([]);
    expect(args.filter((arg) => arg === '-e')).toHaveLength(6);
    expect(args.some((arg) => arg.includes(token))).toBe(false);
  });
});

describe('ensureDocker', () => {
  it('rejects when Docker is not installed', async () => {
    const { run } = runner(() => ({ code: null, stdout: '' }));
    await expect(
      ensureDocker({ run, isRoot: true, hasSystemd: false, log: () => {} }),
    ).rejects.toThrow('Docker is not installed. See docs/development/local-setup.md.');
  });

  it('rejects when the service is down and cannot be started here', async () => {
    const { run, calls } = runner(({ args }) => (args[0] === 'info' ? failed : ok));
    await expect(
      ensureDocker({ run, isRoot: false, hasSystemd: false, log: () => {} }),
    ).rejects.toThrow('The Docker service is not running. Start it and run the command again.');
    expect(calls.some((call) => call.command === 'dockerd')).toBe(false);
  });

  it('starts dockerd once as root without systemd and waits for it', async () => {
    let started = false;
    const { run, calls } = runner(({ command, args }) => {
      if (command === 'dockerd') {
        started = true;
        return ok;
      }
      if (args[0] === 'info') return started ? ok : failed;
      return ok;
    });
    await ensureDocker({ run, isRoot: true, hasSystemd: false, log: () => {} });
    expect(calls.filter((call) => call.command === 'dockerd')).toHaveLength(1);
    expect(calls.at(-1)).toEqual({ command: 'docker', args: ['info'] });
  });
});

describe('hostGitIdentity', () => {
  it('returns nothing when git config fails', async () => {
    const { run } = runner(() => failed);
    await expect(hostGitIdentity({ run })).resolves.toEqual({});
  });
});
