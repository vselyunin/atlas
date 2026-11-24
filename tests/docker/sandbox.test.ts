import { execFile } from 'node:child_process';
import { chown, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IMAGE } from '../../scripts/worker-container.mjs';
import {
  AGENT_GIT_EMAIL,
  AGENT_GIT_NAME,
  BUILD_TIMEOUT_MS,
  fixtures,
  prepareImage,
  probeResults,
  repoRoot,
  startStack,
  stopAllStacks,
} from './support/stack.js';
import type { Board, Stack, StackOptions } from './support/stack.js';

const execute = promisify(execFile);
const TEST_TIMEOUT_MS = 240_000;
const WAIT = { timeout: 60_000, interval: 250 };
const NOT_STARTED = 'The agent sandbox could not start, so the agent was not started';
const probe = join(fixtures, 'probe.mjs');
const claude = join(fixtures, 'claude');
const probeAgent: StackOptions['agent'] = ({ stateDir }) => ['node', probe, stateDir];

// A cold image build can take longer than a test, so it gets its own timeout.
beforeAll(() => prepareImage(), BUILD_TIMEOUT_MS);

// Stops stacks that are still starting too, for example after a test timed out.
afterEach(() => stopAllStacks(), 60_000);
afterAll(() => stopAllStacks(), 60_000);

// The probe's results are the evidence of these tests, so they are shown even when they pass.
function logProbeLines(output: string) {
  const lines = output.replaceAll('\r', '').split('\n');
  console.log(lines.filter((line) => line.startsWith('PROBE')).join('\n'));
}

// Starts a task's session and waits until the agent has exited.
async function runToExit(running: Stack, taskId: string): Promise<Board> {
  const board = await running.boardSocket(taskId);
  await expect.poll(() => board.session?.state, WAIT).toBe('none');
  board.send({ type: 'start', cols: 200, rows: 50 });
  await expect.poll(() => board.session?.state, WAIT).toBe('exited');
  return board;
}

describe('the agent sandbox in the Worker container', () => {
  it(
    'lets the agent write and commit in its worktree and blocks everything else',
    async () => {
      const stack = await startStack({ agent: probeAgent });
      // Another task first, so a second worktree exists.
      const other = await stack.createLocalTask('repo', 'Other task');
      const otherBoard = await runToExit(stack, other.taskId);
      expect(otherBoard.output).toContain('PROBE argv');

      const { taskId } = await stack.createLocalTask('repo', 'Probe task');
      const board = await runToExit(stack, taskId);
      const output = board.output;
      logProbeLines(output);
      const results = probeResults(output);
      expect(results.get('argv'), output).toBe('[]');
      expect(Object.fromEntries(results), output).toMatchObject({
        'write-worktree': 'ok',
        commit: 'ok',
        'write-main-checkout': 'blocked',
        'write-other-worktree': 'blocked',
        'write-main-hooks': 'blocked',
        'write-main-config': 'blocked',
        'write-worktree-commondir': 'blocked',
        'write-worktree-gitdir': 'blocked',
        'write-worktree-config.worktree': 'blocked',
        'replace-worktree-commondir': 'blocked',
        'write-worktree-dotgit': 'blocked',
        'replace-worktree-dotgit': 'blocked',
        'write-outside': 'blocked',
        // Claude's temporary folder is writable only for the Claude profile.
        'write-claude-tmp': 'blocked',
        'write-home-outside': 'blocked',
        'read-state-dir': 'blocked',
        network: 'blocked',
      });

      const { stdout } = await execute('git', [
        '-c',
        'safe.directory=*',
        '-C',
        join(stack.workspace, 'repo'),
        'log',
        '-1',
        '--format=%an%n%ae%n%cn%n%ce%n%s',
        `refs/heads/atlas/task-${taskId}`,
      ]);
      expect(stdout.trim().split('\n')).toEqual([
        AGENT_GIT_NAME,
        AGENT_GIT_EMAIL,
        AGENT_GIT_NAME,
        AGENT_GIT_EMAIL,
        'probe',
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails the session and runs no agent under Docker's default seccomp profile",
    async () => {
      const stack = await startStack({ seccomp: 'default', agent: probeAgent });
      const { taskId } = await stack.createLocalTask('repo', 'Probe task');
      const board = await runToExit(stack, taskId);
      const message = board.session?.message ?? '';
      expect(message.startsWith(NOT_STARTED), message).toBe(true);
      expect(board.states).not.toContain('running');
      expect(board.output).not.toContain('PROBE');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'gives the Claude profile inert task text and its own writable paths',
    async () => {
      // Named claude, so the Worker passes the prompt and the Claude flags and paths.
      const stack = await startStack({
        agent: ({ stateDir }) => [claude, stateDir],
        // Shows the network probe can succeed, so its `blocked` above is not vacuous.
        extraDomains: ['example.com'],
      });
      const title = 'a "b" $(touch /tmp/pwned) ; id';
      const { taskId } = await stack.createLocalTask('repo', title);
      const board = await runToExit(stack, taskId);
      const output = board.output;
      logProbeLines(output);
      const results = probeResults(output);
      const argv = JSON.parse(results.get('argv') ?? 'null') as unknown;
      expect(Array.isArray(argv), output).toBe(true);
      expect(argv).toContain('--dangerously-skip-permissions');
      expect((argv as unknown[]).at(-1)).toBe(`Task: ${title}`);
      expect(Object.fromEntries(results), output).toMatchObject({
        network: 'ok',
        // Claude creates /tmp/claude when it starts and exits if it cannot.
        'write-claude-tmp': 'ok',
        'write-home-outside': 'blocked',
        'write-outside': 'blocked',
      });
      expect(await stack.exec(['test', '!', '-e', '/tmp/pwned'])).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the sandbox readiness check', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  // The Worker's check, run with the real srt in the image under the narrow profile.
  async function check(settingsPath: string, folder: string): Promise<number> {
    try {
      await execute(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'host',
          '--security-opt',
          `seccomp=${repoRoot}/docker/worker/seccomp.json`,
          '-v',
          `${folder}:${folder}:ro`,
          '--entrypoint',
          'srt',
          IMAGE,
          '--settings',
          settingsPath,
          '--',
          'test',
          '!',
          '-e',
          settingsPath,
        ],
        { timeout: 60_000 },
      );
      return 0;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return typeof code === 'number' ? code : -1;
    }
  }

  async function settingsFile(name: string, denyRead: (folder: string) => string[]) {
    directory ??= await mkdtemp(join(tmpdir(), 'atlas-docker-check-'));
    const folder = join(directory, name);
    await mkdir(folder);
    const path = join(folder, 'settings.json');
    const settings = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: denyRead(folder), allowWrite: [], denyWrite: [] },
    };
    await writeFile(path, JSON.stringify(settings));
    for (const target of [directory, folder, path]) await chown(target, 1001, 1001);
    return { path, root: directory };
  }

  it(
    'passes when the settings folder is denied and fails when it is not',
    async () => {
      await prepareImage();
      const denied = await settingsFile('denied', (folder) => [folder]);
      expect(await check(denied.path, denied.root)).toBe(0);
      const visible = await settingsFile('visible', () => []);
      expect(await check(visible.path, visible.root)).not.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
