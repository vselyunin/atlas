import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RepositoryInitCommand } from '@atlas/contracts';
import { Journal } from '../src/state/journal.js';
import { initializeRepository } from '../src/repositories/initialize.js';
import { resolveTarget } from '../src/repositories/paths.js';

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atlas-paths-'));
  root = join(directory, 'repos');
  await mkdir(root);
  await mkdir(join(directory, 'state'));
});
afterEach(async () => {
  delete process.env.ATLAS_WORKER_TOKEN;
  await rm(directory, { recursive: true, force: true });
});

it.each(['.atlas-worktrees/x/y', '.hidden'])(
  'refuses a first segment starting with a dot: %s',
  async (path) => {
    await expect(resolveTarget(root, path)).rejects.toThrow();
  },
);

it('accepts a later segment starting with a dot', async () => {
  await mkdir(join(root, 'a'));
  expect(await resolveTarget(root, 'a/.b')).toBe(join(root, 'a', '.b'));
});

it('runs git init without ATLAS_ variables', async () => {
  const dump = join(directory, 'env.txt');
  const git = join(directory, 'fake-git.sh');
  await writeFile(git, `#!/bin/sh\nenv > '${dump}'\nmkdir -p "$4/.git"\n`);
  await chmod(git, 0o755);
  process.env.ATLAS_WORKER_TOKEN = 'secret';
  const command: RepositoryInitCommand = {
    protocolVersion: 1,
    messageId: randomUUID(),
    type: 'command.dispatch',
    commandId: randomUUID(),
    payload: { kind: 'repository.init', projectId: 'p1', relativePath: 'example' },
  };
  const outcome = await initializeRepository(command, {
    root,
    git,
    journal: new Journal(join(directory, 'state')),
  });
  expect(outcome.status).toBe('succeeded');
  const names = (await readFile(dump, 'utf8')).split('\n').map((line) => line.split('=')[0]);
  expect(names.length).toBeGreaterThan(1);
  expect(names.filter((name) => name?.startsWith('ATLAS_'))).toEqual([]);
});
