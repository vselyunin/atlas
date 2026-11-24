import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { agentArgs, agentProfile } from '../src/sessions/agents.js';
import {
  PLACEHOLDER_NAMES,
  SandboxUnavailableError,
  agentEnvironment,
  prepareSandbox,
  sandboxSettings,
  writeExcludesFile,
} from '../src/sessions/sandbox.js';
import type { SandboxSettings } from '../src/sessions/sandbox.js';
import { ensureWorktree } from '../src/sessions/worktree.js';
import type { Worktree } from '../src/sessions/worktree.js';
import { writeFakeSrt } from './support/sandbox.js';
import { startPayload } from './support/sessions.js';

const run = promisify(execFile);
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const claude = agentProfile(['claude']);

let directory: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-sandbox-')));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]) {
  return (await run('git', [...identity, ...args], { cwd })).stdout.trim();
}

describe('agent profiles', () => {
  it('recognizes Claude by the base name of the command', () => {
    const profile = agentProfile(['/usr/bin/claude']);
    expect(profile).toMatchObject({
      kind: 'claude',
      takesPrompt: true,
      sandboxArgs: ['--dangerously-skip-permissions'],
      domains: ['api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai', '*.claude.com'],
    });
    expect(profile.writablePaths('/home/atlas')).toEqual([
      '/home/atlas/.claude',
      '/home/atlas/.claude.json',
      '/tmp/claude',
    ]);
  });

  it('treats any other command as a custom agent', () => {
    const profile = agentProfile(['node', 'x.mjs']);
    expect(profile).toMatchObject({
      kind: 'custom',
      takesPrompt: false,
      sandboxArgs: [],
      domains: [],
    });
    expect(profile.writablePaths('/home/atlas')).toEqual([]);
  });

  it('separates the writable folders the Worker creates from the writable files', () => {
    const home = '/home/atlas';
    const lists = (command: string) => {
      const profile = agentProfile([command]);
      return {
        directories: profile.writableDirectories(home),
        files: profile.writableFiles(home),
        all: profile.writablePaths(home),
      };
    };
    expect(lists('claude')).toEqual({
      directories: ['/home/atlas/.claude', '/tmp/claude'],
      files: ['/home/atlas/.claude.json'],
      all: ['/home/atlas/.claude', '/home/atlas/.claude.json', '/tmp/claude'],
    });
    expect(lists('/usr/bin/codex')).toEqual({
      directories: ['/home/atlas/.codex'],
      files: [],
      all: ['/home/atlas/.codex'],
    });
    expect(lists('node')).toEqual({ directories: [], files: [], all: [] });
  });

  it('turns permission prompts off only when sandboxed and protects a leading dash', () => {
    const sandboxed = agentArgs(claude, ['claude'], '--resume', true);
    expect(sandboxed.at(-1)).toBe(' --resume');
    expect(sandboxed).toContain('--dangerously-skip-permissions');

    const plain = agentArgs(claude, ['claude'], '--resume', false);
    expect(plain.at(-1)).toBe(' --resume');
    expect(plain).not.toContain('--dangerously-skip-permissions');
  });

  it('passes a prompt with shell syntax through as one unmodified argument', () => {
    const prompt = 'a "b" $(touch /x) `id`; rm -rf /';
    const args = agentArgs(claude, ['claude', '--model', 'x'], prompt, true);
    expect(args).toEqual(['--model', 'x', '--dangerously-skip-permissions', prompt]);
  });

  it('does not give the prompt to a custom agent', () => {
    expect(agentArgs(agentProfile(['node', 'x.mjs']), ['node', 'x.mjs'], 'hi', true)).toEqual([
      'x.mjs',
    ]);
  });
});

describe('sandboxSettings', () => {
  it('allows writes to the worktree, its Git data and the agent state only', () => {
    const worktree: Worktree = {
      path: '/srv/my repos/.atlas-worktrees/my%20app/task 1',
      branch: 'atlas/task-1',
      gitDir: '/srv/my repos/my app/.git/worktrees/task 1',
      commonDir: '/srv/my repos/my app/.git',
    };

    const settings = sandboxSettings({
      worktree,
      stateDir: '/srv/worker state',
      home: '/home/atlas',
      profile: claude,
      allowedDomains: ['registry.npmjs.org', 'claude.ai'],
    });

    expect(settings).toEqual<SandboxSettings>({
      network: {
        allowedDomains: [
          'api.anthropic.com',
          '*.anthropic.com',
          'claude.ai',
          '*.claude.ai',
          '*.claude.com',
          'registry.npmjs.org',
        ],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: ['/srv/worker state'],
        allowWrite: [
          '/srv/my repos/.atlas-worktrees/my%20app/task 1',
          '/srv/my repos/my app/.git/objects',
          '/srv/my repos/my app/.git/worktrees/task 1',
          '/srv/my repos/my app/.git/refs/heads/atlas',
          '/srv/my repos/my app/.git/logs',
          '/home/atlas/.claude',
          '/home/atlas/.claude.json',
          '/tmp/claude',
        ],
        denyWrite: [
          '/srv/my repos/my app/.git/worktrees/task 1/commondir',
          '/srv/my repos/my app/.git/worktrees/task 1/gitdir',
          '/srv/my repos/my app/.git/worktrees/task 1/config.worktree',
        ],
      },
    });
  });

  it("allows writes to a legacy worktree's real Git dir", async () => {
    const root = join(directory, 'repos');
    const repo = join(root, 'team/app');
    await mkdir(repo, { recursive: true });
    await git(repo, 'init', '--quiet', '-b', 'main');
    await git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'chore: seed');
    const id = randomUUID();
    const shortKey = id.replaceAll('-', '').slice(0, 8);
    const legacy = join(root, '.atlas-worktrees', 'team__app', shortKey);
    await git(repo, 'worktree', 'add', '-b', `atlas/task-${shortKey}`, legacy);

    const worktree = await ensureWorktree(root, repo, startPayload(id, 'team/app'));
    const settings = sandboxSettings({
      worktree,
      stateDir: join(directory, 'state'),
      home: '/home/atlas',
      profile: claude,
      allowedDomains: [],
    });

    const gitDir = await git(legacy, 'rev-parse', '--absolute-git-dir');
    expect(settings.filesystem.allowWrite).toContain(gitDir);
    expect(gitDir).not.toContain(id);
  });
});

describe('agentEnvironment', () => {
  const agent = { command: ['claude'], sandbox: 'required' as const, allowedDomains: [] };

  it('hides Atlas settings and points Git at the excludes file', () => {
    vi.stubEnv('ATLAS_WORKER_TOKEN', 'must-not-leak');
    const env = agentEnvironment('/srv/repos', agent, '/tmp/excludes');
    expect(Object.keys(env).filter((name) => name.startsWith('ATLAS_'))).toEqual([]);
    expect(env).toMatchObject({
      GIT_CEILING_DIRECTORIES: '/srv/repos',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: '/tmp/excludes',
    });
  });

  it('sets the commit identity only when both name and email are set', () => {
    vi.stubEnv('GIT_AUTHOR_NAME', undefined);
    vi.stubEnv('GIT_COMMITTER_NAME', undefined);
    vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
    vi.stubEnv('GIT_COMMITTER_EMAIL', undefined);
    const identityNames = [
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_EMAIL',
    ];
    const both = agentEnvironment(
      '/srv/repos',
      { ...agent, gitName: 'Ada', gitEmail: 'ada@example.com' },
      '/tmp/x',
    );
    expect(both).toMatchObject({
      GIT_AUTHOR_NAME: 'Ada',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    });

    for (const partial of [{ gitName: 'Ada' }, { gitEmail: 'ada@example.com' }]) {
      const env = agentEnvironment('/srv/repos', { ...agent, ...partial }, '/tmp/x');
      expect(identityNames.filter((name) => name in env)).toEqual([]);
    }
  });
});

describe('writeExcludesFile', () => {
  it('lists every sandbox placeholder at the repository root', async () => {
    const path = await writeExcludesFile();
    try {
      expect(path.startsWith(`${tmpdir()}/`)).toBe(true);
      const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
      expect(lines).toEqual(PLACEHOLDER_NAMES.map((name) => `/${name}`));
      expect(lines).toHaveLength(13);
      expect(lines).toContain('/.claude/agents');
      expect(lines).toContain('/.claude/commands');
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  });

  it('makes Git ignore the placeholders without touching the repository', async () => {
    const repo = join(directory, 'app');
    await mkdir(repo);
    await git(repo, 'init', '--quiet', '-b', 'main');
    await mkdir(join(repo, '.claude'));
    for (const name of PLACEHOLDER_NAMES) await writeFile(join(repo, name), '');
    await writeFile(join(repo, 'real.txt'), 'kept');
    const path = await writeExcludesFile();
    try {
      const env = agentEnvironment(
        directory,
        { command: ['claude'], sandbox: 'required', allowedDomains: [] },
        path,
      );
      const status = await run('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: repo,
        env,
      });
      expect(status.stdout.trim()).toBe('?? real.txt');
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  });
});

describe('prepareSandbox', () => {
  const settings: SandboxSettings = {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  };

  async function prepare(pathDirectory: string) {
    const stateDir = join(directory, 'state');
    await mkdir(stateDir, { recursive: true });
    return prepareSandbox({
      sessionKey: 'task-1',
      settings,
      stateDir,
      cwd: directory,
      // The system folders let a fake srt run its command; they hold no srt.
      env: { PATH: `${pathDirectory}:/usr/bin:/bin` },
    });
  }

  it('writes a private settings file and checks the sandbox with srt', async () => {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    const srt = await writeFakeSrt(bin, 'exec');

    const { settingsPath } = await prepare(bin);

    const stateDir = join(directory, 'state');
    expect(settingsPath).toBe(join(stateDir, 'sessions', 'task-1.json'));
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(settings);
    expect(await srt.calls()).toEqual([
      ['--settings', settingsPath, '--', 'test', '!', '-e', settingsPath],
    ]);
  });

  it('rejects a sandbox that does not hide the Worker state folder', async () => {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFakeSrt(bin, 'unsandboxed');

    const attempt = prepare(bin);

    await expect(attempt).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(attempt).rejects.toThrow(
      /^The agent sandbox could not start, so the agent was not started: the sandbox did not hide the Worker state folder$/,
    );
  });

  it('rewrites the settings file on every start', async () => {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFakeSrt(bin, 'exec');
    const { settingsPath } = await prepare(bin);
    await writeFile(settingsPath, 'stale', { mode: 0o644 });

    await prepare(bin);

    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(settings);
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  it('names the cause when the sandbox fails to start', async () => {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFakeSrt(bin, 'fail');

    const attempt = prepare(bin);

    await expect(attempt).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(attempt).rejects.toThrow(
      /^The agent sandbox could not start, so the agent was not started: bwrap: nope$/,
    );
  });

  it("creates the agent's missing writable folders before the check runs", async () => {
    const home = join(directory, 'home');
    const writableDirectories = [
      ...agentProfile(['codex']).writableDirectories(home),
      join(home, 'nested', 'state'),
    ];
    const bin = join(directory, 'bin');
    await mkdir(bin);
    // This srt passes its check only when every writable folder already exists.
    const tests = writableDirectories.map((path) => `[ -d '${path}' ]`).join(' && ');
    await writeFile(
      join(bin, 'srt'),
      `#!/bin/sh\n${tests} || { echo 'srt: a writable folder is missing' >&2; exit 1; }\n`,
      { mode: 0o755 },
    );
    const stateDir = join(directory, 'state');
    await mkdir(stateDir);

    await prepareSandbox({
      sessionKey: 'task-1',
      settings,
      stateDir,
      cwd: directory,
      env: { PATH: `${bin}:/usr/bin:/bin` },
      writableDirectories,
    });

    for (const path of writableDirectories) expect((await stat(path)).isDirectory()).toBe(true);
  });

  it('does not run the check when a writable folder cannot be created', async () => {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    const srt = await writeFakeSrt(bin, 'exec');
    const blocker = join(directory, 'file');
    await writeFile(blocker, '');
    const stateDir = join(directory, 'state');
    await mkdir(stateDir);

    const attempt = prepareSandbox({
      sessionKey: 'task-1',
      settings,
      stateDir,
      cwd: directory,
      env: { PATH: `${bin}:/usr/bin:/bin` },
      writableDirectories: [join(blocker, '.codex')],
    });

    await expect(attempt).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(attempt).rejects.toThrow(
      /^The agent sandbox could not start, so the agent was not started: ENOTDIR/,
    );
    expect(await srt.calls()).toEqual([]);
  });

  it('fails closed when srt is missing', async () => {
    const empty = join(directory, 'empty');
    await mkdir(empty);

    const attempt = prepare(empty);

    await expect(attempt).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(attempt).rejects.toThrow(
      /^The agent sandbox could not start, so the agent was not started: /,
    );
  });
});
