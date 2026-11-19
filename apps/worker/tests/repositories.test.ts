import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RepositoryInitCommand } from '@atlas/contracts';
import { Journal } from '../src/state/journal.js';
import { initializeRepository } from '../src/repositories/initialize.js';
import { acquireLock } from '../src/state/lock.js';
let directory: string;
let root: string;
let state: string;
let journal: Journal;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atlas-worker-'));
  root = join(directory, 'repos');
  state = join(directory, 'state');
  await mkdir(root);
  await mkdir(state);
  journal = new Journal(state);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function command(path = 'example'): RepositoryInitCommand {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    type: 'command.dispatch',
    commandId: randomUUID(),
    payload: { kind: 'repository.init', projectId: 'p1', relativePath: path },
  };
}
it('initializes a fresh repository and deduplicates delivery', async () => {
  const job = command();
  const context = { root, journal };
  const outcome = await initializeRepository(job, context);
  expect(outcome).toEqual({ status: 'succeeded', localPath: join(root, 'example') });
  expect(await initializeRepository({ ...job, messageId: randomUUID() }, context)).toEqual(outcome);
  expect(await readdir(join(root, 'example'))).toEqual(['.git']);
  expect(await readFile(join(root, 'example', '.git', 'config'), 'utf8')).not.toContain('[remote');
  expect(await readdir(join(root, 'example', '.git', 'refs', 'heads'))).toEqual([]);
});
it('preserves an existing directory and its contents', async () => {
  await mkdir(join(root, 'example'));
  await writeFile(join(root, 'example', 'keep.txt'), 'keep');
  expect((await initializeRepository(command(), { root, journal })).status).toBe('failed');
  expect(await readdir(join(root, 'example'))).toEqual(['keep.txt']);
  expect(await readFile(join(root, 'example', 'keep.txt'), 'utf8')).toBe('keep');
});
it.each(['../escape', '/tmp/escape', '.', 'nested/../../escape'])(
  'rejects unsafe path %s',
  async (path) => {
    expect((await initializeRepository(command(path), { root, journal })).status).toBe('failed');
    expect(await readdir(root)).toEqual([]);
  },
);
it('rejects a symlinked parent', async () => {
  await symlink(directory, join(root, 'link'));
  expect((await initializeRepository(command('link/escape'), { root, journal })).status).toBe(
    'failed',
  );
});
it('rejects changed payload for a reused command id', async () => {
  const job = command();
  await initializeRepository(job, { root, journal });
  await expect(
    initializeRepository(
      { ...job, payload: { ...job.payload, relativePath: 'another' } },
      { root, journal },
    ),
  ).rejects.toThrow('different payload');
  expect(await readdir(root)).toEqual(['example']);
});
it('marks unproven crash recovery for attention without touching the folder', async () => {
  const job = command();
  await mkdir(join(root, 'example'));
  journal.write({
    command: job,
    target: join(root, 'example'),
    stage: 'queued',
    identity: null,
    outcome: null,
    acknowledged: false,
  });
  expect((await initializeRepository(job, { root, journal })).status).toBe('needs_attention');
  expect(await readdir(join(root, 'example'))).toEqual([]);
});
it('preserves the created folder when Git is unavailable', async () => {
  expect(
    (await initializeRepository(command(), { root, journal, git: join(directory, 'missing-git') }))
      .status,
  ).toBe('failed');
  expect(await readdir(root)).toEqual(['example']);
});
it('requires an exclusive local worker lock', () => {
  const release = acquireLock(state);
  expect(() => acquireLock(state)).toThrow('Another Worker');
  release();
  acquireLock(state)();
});
