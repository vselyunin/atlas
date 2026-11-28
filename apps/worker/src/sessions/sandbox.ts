import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentSettings } from '../config.js';
import type { AgentProfile } from './agents.js';
import { agentObjectEnvironment } from './objects.js';
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
  // These two appear once the agent has created `.claude` in the worktree.
  '.claude/agents',
  '.claude/commands',
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

// Files in a worktree's Git folder that point Git at the shared repository and its config.
export const WORKTREE_LINK_FILES: readonly string[] = ['commondir', 'gitdir', 'config.worktree'];

export function sandboxSettings(input: {
  worktree: Worktree;
  stateDir: string;
  home: string;
  profile: AgentProfile;
  allowedDomains: string[];
  // Further folders the agent may write, such as its status folder.
  extraWritable?: string[];
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
        // Holds the agent's own object folder too. The project's object store is not writable.
        worktree.gitDir,
        // Task branches are named atlas/task-<id>, so agents can move only those branches.
        join(worktree.commonDir, 'refs', 'heads', 'atlas'),
        join(worktree.commonDir, 'logs'),
        ...profile.writablePaths(input.home),
        ...(input.extraWritable ?? []),
      ],
      // These files decide which config and hooks Git uses in the worktree. An agent that could
      // rewrite them would get its own commands run by Git outside the sandbox.
      denyWrite: WORKTREE_LINK_FILES.map((name) => join(worktree.gitDir, name)),
    },
  };
}

export function agentEnvironment(
  root: string,
  agent: AgentSettings,
  excludesFile: string,
  worktree: Worktree,
): Record<string, string> {
  const env = { ...childEnvironment(root), ...agentObjectEnvironment(worktree) };
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

function checkFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { stderr?: unknown; code?: unknown; killed?: unknown };
  const stderr = typeof details.stderr === 'string' ? firstLine(details.stderr) : '';
  if (stderr) return stderr;
  // The check ran but found the settings file: the sandbox was not in effect.
  if (typeof details.code === 'number' && details.killed !== true) {
    return 'the sandbox did not hide the Worker state folder';
  }
  return firstLine(error.message);
}

export async function prepareSandbox(input: {
  sessionKey: string;
  settings: SandboxSettings;
  stateDir: string;
  cwd: string;
  env: Record<string, string>;
  // Writable folders of the agent that must exist, because the sandbox can bind only existing
  // paths writable; a missing one would stay read-only for the agent.
  writableDirectories?: string[];
}): Promise<{ settingsPath: string }> {
  const directory = join(input.stateDir, 'sessions');
  const settingsPath = join(directory, `${input.sessionKey}.json`);
  try {
    for (const writable of input.writableDirectories ?? []) {
      await mkdir(writable, { recursive: true });
    }
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
    // Prove the sandbox works: the denied state folder appears empty inside it, so the settings
    // file in it must not exist there. `--` stops srt reading the command's options as its own.
    await run('srt', ['--settings', settingsPath, '--', 'test', '!', '-e', settingsPath], {
      cwd: input.cwd,
      env: input.env,
      timeout: CHECK_TIMEOUT_MS,
    });
  } catch (error) {
    throw new SandboxUnavailableError(checkFailure(error));
  }
  return { settingsPath };
}
