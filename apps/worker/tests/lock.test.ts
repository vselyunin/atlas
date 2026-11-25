import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../src/state/lock.js';

let state: string;
let lockPath: string;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), 'atlas-lock-'));
  lockPath = join(state, 'worker.lock');
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
});

async function lockContent() {
  return readFile(lockPath, 'utf8');
}

it('refuses a second lock in the same process', () => {
  const release = acquireLock(state);
  expect(() => acquireLock(state)).toThrow('Another Worker is using this state directory');
  release();
});

it('takes over an old-format lock holding only this process ID', async () => {
  await writeFile(lockPath, String(process.pid));
  const release = acquireLock(state);
  expect(await lockContent()).toMatch(new RegExp(`^${process.pid} [0-9a-f-]{36}$`));
  release();
});

it('takes over a lock with this process ID and a token it does not hold', async () => {
  await writeFile(lockPath, `${process.pid} 00000000-0000-4000-8000-000000000000`);
  const release = acquireLock(state);
  expect(await lockContent()).not.toContain('00000000-0000-4000-8000-000000000000');
  release();
});

it('takes over a lock from a process that has exited', async () => {
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(child.pid).toBeGreaterThan(0);
  await writeFile(lockPath, `${child.pid} 00000000-0000-4000-8000-000000000000`);
  const release = acquireLock(state);
  expect(await lockContent()).toMatch(new RegExp(`^${process.pid} `));
  release();
});

it('refuses a lock held by another live process', async () => {
  await writeFile(lockPath, `${process.ppid} 00000000-0000-4000-8000-000000000000`);
  expect(() => acquireLock(state)).toThrow('Another Worker is using this state directory');
});

it('leaves a lock taken over by someone else in place on release', async () => {
  const release = acquireLock(state);
  const foreign = `${process.ppid} 00000000-0000-4000-8000-000000000000`;
  await writeFile(lockPath, foreign);
  release();
  expect(await lockContent()).toBe(foreign);
});

it('refuses an unparsable lock', async () => {
  await writeFile(lockPath, 'not a lock');
  expect(() => acquireLock(state)).toThrow('Invalid Worker lock; inspect it before removing it');
});
