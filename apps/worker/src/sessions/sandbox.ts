import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentSettings } from '../config.js';
import type { AgentProfile } from './agents.js';
import { childEnvironment } from './worktree.js';
import type { Worktree } from './worktree.js';

const run = promisify(execFile);
const CHECK_TIMEOUT_MS = 15_000;

// The settings file format of `srt`, Anthropic's sandbox runtime.
export interface SandboxSettings {
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

export class SandboxUnavailableError extends Error {
  constructor(cause: string) {
    super(`The agent sandbox could not start, so the agent was not started: ${cause}`);
    this.name = 'SandboxUnavailableError';
  }
}

export const SANDBOX_ON_NOTICE =
  "Atlas: agent sandbox on. Writes are limited to this task's worktree.\r\n";
export const SANDBOX_OFF_NOTICE =
  'Atlas: agent sandbox OFF. The agent can change anything the Worker can.\r\n';

// Files the sandbox puts in the worktree to block writes to them; Git must not pick them up.
export const PLACEHOLDER_NAMES: readonly string[] = [
  '.bash_profile',
  '.bashrc',
  '.gitconfig',
  '.gitmodules',
  '.idea',
  '.mcp.json',
  '.profile',
  '.ripgreprc',
  '.vscode',
  '.zprofile',
  '.zshrc',
];

export function sandboxSettings(input: {
  worktree: Worktree;
  stateDir: string;
  home: string;
  profile: AgentProfile;
  allowedDomains: string[];
}): SandboxSettings {
  const { worktree, profile } = input;
  return {
    network: {
      allowedDomains: [...new Set([...profile.domains, ...input.allowedDomains])],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [input.stateDir],
      allowWrite: [
        worktree.path,
        join(worktree.commonDir, 'objects'),
        worktree.gitDir,
        // Task branches are named atlas/task-<id>, so agents can move only those branches.
        join(worktree.commonDir, 'refs', 'heads', 'atlas'),
        join(worktree.commonDir, 'logs'),
        ...profile.writablePaths(input.home),
      ],
      denyWrite: [],
    },
  };
}

export function agentEnvironment(
  root: string,
  agent: AgentSettings,
  excludesFile: string,
): Record<string, string> {
  const env = childEnvironment(root);
  // An excludes file from the environment keeps the user's repository untouched.
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'core.excludesFile';
  env.GIT_CONFIG_VALUE_0 = excludesFile;
  if (agent.gitName !== undefined && agent.gitEmail !== undefined) {
    env.GIT_AUTHOR_NAME = agent.gitName;
    env.GIT_COMMITTER_NAME = agent.gitName;
    env.GIT_AUTHOR_EMAIL = agent.gitEmail;
    env.GIT_COMMITTER_EMAIL = agent.gitEmail;
  }
  return env;
}

export async function writeExcludesFile(): Promise<string> {
  // Outside the Worker state directory, which the agent cannot read.
  const directory = await mkdtemp(join(tmpdir(), 'atlas-excludes-'));
  const path = join(directory, 'excludes');
  await writeFile(path, PLACEHOLDER_NAMES.map((name) => `/${name}\n`).join(''), { mode: 0o644 });
  return path;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

export async function prepareSandbox(input: {
  sessionKey: string;
  settings: SandboxSettings;
  stateDir: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<{ settingsPath: string }> {
  const directory = join(input.stateDir, 'sessions');
  const settingsPath = join(directory, `${input.sessionKey}.json`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Replace the file rather than write through it, so it is always new and private.
    await rm(settingsPath, { force: true });
    await writeFile(settingsPath, `${JSON.stringify(input.settings, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    throw new SandboxUnavailableError(error instanceof Error ? error.message : String(error));
  }
  try {
    // Prove the sandbox works: inside it, the Worker state directory must be unreadable.
    await run(
      'srt',
      ['--settings', settingsPath, 'sh', '-c', '! test -r "$1"', 'sh', input.stateDir],
      { cwd: input.cwd, env: input.env, timeout: CHECK_TIMEOUT_MS },
    );
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
        ? firstLine(error.stderr)
        : '';
    throw new SandboxUnavailableError(
      stderr || firstLine(error instanceof Error ? error.message : String(error)),
    );
  }
  return { settingsPath };
}
