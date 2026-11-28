import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustWorktree } from '../src/sessions/trust.js';

// Lets one test make the first sync of an opened file fail.
const failure = vi.hoisted(() => ({ syncOnce: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync' && failure.syncOnce) {
            return () => {
              failure.syncOnce = false;
              return Promise.reject(new Error('disk full'));
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? (value.bind(target) as unknown) : value;
        },
      });
    },
  };
});

let dir: string;
let config: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-session-trust-'));
  config = join(dir, '.claude.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('marks the worktree trusted and keeps everything else in place', async () => {
  const original = {
    theme: 'dark',
    projects: { '/other': { allowedTools: ['x'] }, '/work': { history: [1], keep: true } },
  };
  await writeFile(config, JSON.stringify(original, null, 2));
  const before = (await stat(config)).ino;

  expect(await trustWorktree(config, '/work')).toBe(true);

  const next: unknown = JSON.parse(await readFile(config, 'utf8'));
  expect(next).toEqual({
    theme: 'dark',
    projects: {
      '/other': { allowedTools: ['x'] },
      '/work': { history: [1], keep: true, hasTrustDialogAccepted: true },
    },
  });
  expect((await readFile(config, 'utf8')).startsWith('{\n  "theme"')).toBe(true);
  expect((await stat(config)).ino).toBe(before);
});

it('adds a project that is not there yet and shortens nothing', async () => {
  await writeFile(config, JSON.stringify({ a: 1 }, null, 2));
  expect(await trustWorktree(config, '/new')).toBe(true);
  expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({
    a: 1,
    projects: { '/new': { hasTrustDialogAccepted: true } },
  });
});

async function expectUntouched(path: string, text: string) {
  expect(await trustWorktree(path, '/work')).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(text);
}

it('returns false and leaves the file alone for an unusable config', async () => {
  expect(await trustWorktree(join(dir, 'missing.json'), '/work')).toBe(false);

  await writeFile(config, '{nope');
  await expectUntouched(config, '{nope');

  await writeFile(config, '[1,2]');
  await expectUntouched(config, '[1,2]');

  const big = JSON.stringify({ pad: 'x'.repeat(5 * 1024 * 1024 + 10) });
  await writeFile(config, big);
  await expectUntouched(config, big);
});

it('restores the original bytes when the write fails after the file changed', async () => {
  const text = JSON.stringify({ theme: 'dark', projects: { '/other': { a: 1 } } });
  await writeFile(config, text);
  const before = (await stat(config)).ino;
  failure.syncOnce = true;
  expect(await trustWorktree(config, '/work')).toBe(false);
  expect(failure.syncOnce).toBe(false);
  expect(await readFile(config, 'utf8')).toBe(text);
  expect((await stat(config)).ino).toBe(before);
});

it('returns false for a symlinked config and leaves the target alone', async () => {
  const target = join(dir, 'target.json');
  await writeFile(target, '{"a":1}');
  await symlink(target, config);
  expect(await trustWorktree(config, '/work')).toBe(false);
  expect(await readFile(target, 'utf8')).toBe('{"a":1}');
});
