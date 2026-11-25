import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILD_TIMEOUT_MS,
  fixtures,
  prepareImage,
  probeResults,
  startStack,
  stopAllStacks,
} from './support/stack.js';
import type { Board, Stack } from './support/stack.js';

const execute = promisify(execFile);
const TEST_TIMEOUT_MS = 240_000;
const WAIT = { timeout: 60_000, interval: 250 };
const probe = join(fixtures, 'environment-probe.mjs');
// The marker is in the environment of every agent process the Worker starts in this test.
const MARKER = `marker-${randomBytes(16).toString('hex')}`;

// A cold image build can take longer than a test, so it gets its own timeout.
beforeAll(() => prepareImage(), BUILD_TIMEOUT_MS);

// Stops stacks that are still starting too, for example after a test timed out.
afterEach(() => stopAllStacks(), 60_000);
afterAll(() => stopAllStacks(), 60_000);

// Runs a script with Node in the container, outside any agent sandbox, as the Worker's user.
async function inContainer(stack: Stack, script: string, ...args: string[]) {
  const { stdout } = await execute(
    'docker',
    ['exec', stack.containerName, 'node', '-e', script, ...args],
    { timeout: 60_000 },
  );
  return stdout;
}

interface ProcessFacts {
  worker?: { pid: number; token: string };
  holders: number[];
}

// Finds the Worker and the agent processes that carry the marker, by reading /proc.
async function findProcesses(stack: Stack): Promise<ProcessFacts> {
  const script = `
    const fs = require('node:fs');
    const marker = process.argv[1];
    const found = { holders: [] };
    for (const entry of fs.readdirSync('/proc').filter((name) => /^\\d+$/.test(name))) {
      try {
        const args = fs.readFileSync('/proc/' + entry + '/cmdline', 'utf8').split('\\0');
        const environment = fs.readFileSync('/proc/' + entry + '/environ', 'utf8');
        if (args[0].endsWith('node') && args[1] === 'dist/main.js') {
          const token = /(?:^|\\0)ATLAS_WORKER_TOKEN=([^\\0]*)/.exec(environment)?.[1] ?? '';
          found.worker = { pid: Number(entry), token };
        } else if (args[0].endsWith('node') && (args[1] ?? '').endsWith('environment-probe.mjs') && environment.includes(marker)) {
          found.holders.push(Number(entry));
        }
      } catch {}
    }
    console.log(JSON.stringify(found));
  `;
  return JSON.parse(await inContainer(stack, script, MARKER)) as ProcessFacts;
}

// Starts a task's session and waits until the agent has exited.
async function runToExit(stack: Stack, taskId: string): Promise<Board> {
  const board = await stack.boardSocket(taskId);
  await expect.poll(() => board.session?.state, WAIT).toBe('none');
  board.send({ type: 'start', cols: 200, rows: 50 });
  await expect.poll(() => board.session?.state, WAIT).toBe('exited');
  return board;
}

describe('the Worker image and its credential helper', () => {
  it(
    'ships the credential helper where the Worker looks for it, and it answers only for its host',
    async () => {
      const stack = await startStack();
      const path = (
        await inContainer(
          stack,
          "import('/opt/atlas/worker/dist/repositories/clone.js').then((module) => console.log(module.credentialHelperPath))",
        )
      ).trim();
      expect(path).toBe('/opt/atlas/worker/dist/repositories/git-credential-helper.sh');
      // Git runs the helper with /bin/sh, so it must exist and be readable by the Worker's user;
      // it needs no executable bit.
      expect(await stack.exec(['test', '-f', path])).toBe(0);
      expect(await stack.exec(['test', '-r', path])).toBe(0);
      expect(await stack.exec(['test', '-s', path])).toBe(0);

      // Run the way Git runs it, with a made-up token that is not a secret.
      const ask = (host: string, operation: string) =>
        execute(
          'docker',
          [
            'exec',
            '-e',
            'ATLAS_GIT_TOKEN=not-a-secret',
            stack.containerName,
            'sh',
            '-c',
            `printf 'protocol=https\\nhost=${host}\\n\\n' | /bin/sh ${path} https git.example.test ${operation}`,
          ],
          { timeout: 60_000 },
        ).then(({ stdout }) => stdout);
      expect(await ask('git.example.test', 'get')).toBe(
        'username=x-access-token\npassword=not-a-secret\n',
      );
      expect(await ask('other.example.test', 'get')).toBe('');
      expect(await ask('git.example.test', 'store')).toBe('');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the Worker credentials inside the agent sandbox', () => {
  it(
    'cannot be read from a sandboxed agent: not the Worker, not another process, not the state directory',
    async () => {
      const stack = await startStack({
        // `env` puts the marker into the agent process, so it exists in a process the Worker started.
        agent: ({ workspace, stateDir }) => [
          'env',
          `PROBE_MARKER=${MARKER}`,
          'node',
          probe,
          stateDir,
          join(workspace, 'targets.json'),
        ],
      });

      // A first session whose agent keeps running with the marker in its environment.
      const holderTask = await stack.createLocalTask('repo', 'Holder');
      const holder = await stack.boardSocket(holderTask.taskId);
      await expect.poll(() => holder.session?.state, WAIT).toBe('none');
      holder.send({ type: 'start', cols: 200, rows: 50 });
      await expect.poll(() => holder.output, WAIT).toContain('HOLDER READY');

      const before = await findProcesses(stack);
      expect(before.worker?.pid).toBeGreaterThan(0);
      expect(before.holders).toHaveLength(1);
      const token = before.worker?.token ?? '';
      expect(token.length).toBeGreaterThan(0);

      // Control: outside the sandbox, the same user reads both environments, so the sandbox is
      // what keeps them from the agent, not the user or the file mode.
      const readable = await inContainer(
        stack,
        `const fs = require('node:fs');
         const [worker, holder, marker] = process.argv.slice(1);
         const read = (pid) => fs.readFileSync('/proc/' + pid + '/environ', 'utf8');
         console.log(JSON.stringify({
           worker: read(worker).includes('ATLAS_WORKER_TOKEN='),
           holder: read(holder).includes(marker),
         }));`,
        String(before.worker?.pid),
        String(before.holders[0]),
        MARKER,
      );
      expect(JSON.parse(readable)).toEqual({ worker: true, holder: true });
      expect(await stack.exec(['sh', '-c', `test -n "$(ls -A ${stack.stateDir})"`])).toBe(0);

      await writeFile(
        join(stack.workspace, 'targets.json'),
        JSON.stringify({ worker: before.worker?.pid, holder: before.holders[0] }),
      );
      const other = await stack.createLocalTask('repo', 'Probe');
      const board = await runToExit(stack, other.taskId);
      await expect.poll(() => board.output, WAIT).toContain('PROBE done');

      // Never put a secret into a message: the output is shown with both secrets removed.
      const output = board.output.replaceAll(MARKER, '[marker]').replaceAll(token, '[token]');
      console.log(
        output
          .replaceAll('\r', '')
          .split('\n')
          .filter((line) => line.startsWith('PROBE'))
          .join('\n'),
      );
      expect(Object.fromEntries(probeResults(output)), output).toMatchObject({
        'read-own-environ': 'ok',
        'read-worker-environ': 'blocked',
        'read-holder-environ': 'blocked',
        'scan-environ': 'blocked',
        'list-state-dir': 'blocked',
      });
      // Neither secret reached the agent's output at all.
      expect(board.output.includes(MARKER)).toBe(false);
      expect(board.output.includes(token)).toBe(false);

      // The holder kept running throughout, so it was there to be read.
      const after = await findProcesses(stack);
      expect(after.holders).toEqual(before.holders);
      expect(after.worker?.pid).toBe(before.worker?.pid);
    },
    TEST_TIMEOUT_MS,
  );
});
