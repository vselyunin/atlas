import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeRepositoryCloneCommandFixture } from '@atlas/contracts';
import type { RepositoryCloneCommand } from '@atlas/contracts';
import { Journal } from '../src/state/journal.js';
import type { JournalEntry } from '../src/state/journal.js';
import { cloneRepository } from '../src/repositories/clone.js';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/journal-before-clone.json', import.meta.url));

let directory: string;
let root: string;
let state: string;
let journal: Journal;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-clone-journal-')));
  root = join(directory, 'repos');
  state = join(directory, 'state');
  await mkdir(root);
  await mkdir(state);
  journal = new Journal(state);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const command = (): RepositoryCloneCommand =>
  makeRepositoryCloneCommandFixture({ commandId: 'operation:clone' });

function context() {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    value: {
      root,
      journal,
      gitHostUrl: 'http://127.0.0.1:9',
      signal: new AbortController().signal,
      requestCredential: () => {
        requests++;
        return Promise.reject(new Error('A recovered clone must not ask for a credential'));
      },
    },
  };
}

// A folder that passes init's recovery test: made by the Worker, with a Git repository inside.
async function preparedFolder(): Promise<{ target: string; dev: number; ino: number }> {
  const target = join(root, 'project');
  await mkdir(target);
  await run('git', ['init', '--quiet', target], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  const info = await lstat(target);
  return { target, dev: info.dev, ino: info.ino };
}

it('reads a journal entry written before clones existed', async () => {
  const id = 'operation:before-clone';
  const name = `${createHash('sha256').update(id).digest('hex')}.json`;
  await copyFile(fixture, join(state, 'commands', name));
  const entry = journal.get(id);
  expect(entry?.command.payload.kind).toBe('repository.init');
  expect(entry?.stage).toBe('finished');
  expect(journal.entries()).toHaveLength(1);
});

it('round-trips a clone entry', () => {
  const entry: JournalEntry = {
    command: command(),
    target: join(root, 'project'),
    stage: 'cloned',
    identity: { dev: 1, ino: 2 },
    outcome: null,
    acknowledged: false,
  };
  journal.write(entry);
  expect(journal.get(entry.command.commandId)).toEqual(entry);
});

it('recovers a clone that stopped before it finished as needing attention', async () => {
  const { target, dev, ino } = await preparedFolder();
  const job = command();
  journal.write({
    command: job,
    target,
    stage: 'created',
    identity: { dev, ino },
    outcome: null,
    acknowledged: false,
  });
  const recovery = context();
  const outcome = await cloneRepository(job, recovery.value);
  expect(outcome).toEqual({
    status: 'needs_attention',
    error: {
      code: 'recovery_uncertain',
      message: `Inspect the preserved target before retrying: ${target}`,
    },
  });
  expect(recovery.requests).toBe(0);
  expect(journal.get(job.commandId)).toMatchObject({ stage: 'finished', outcome });
  expect(await readdir(target)).toEqual(['.git']);
});

it('recovers a clone that reached the cloned stage as succeeded', async () => {
  const { target, dev, ino } = await preparedFolder();
  const job = command();
  journal.write({
    command: job,
    target,
    stage: 'cloned',
    identity: { dev, ino },
    outcome: null,
    acknowledged: false,
  });
  const recovery = context();
  const outcome = await cloneRepository(job, recovery.value);
  expect(outcome).toEqual({ status: 'succeeded', localPath: target });
  expect(recovery.requests).toBe(0);
});

it('does not trust a cloned stage when the folder was replaced', async () => {
  const { target } = await preparedFolder();
  const job = command();
  journal.write({
    command: job,
    target,
    stage: 'cloned',
    identity: { dev: 1, ino: 1 },
    outcome: null,
    acknowledged: false,
  });
  expect((await cloneRepository(job, context().value)).status).toBe('needs_attention');
});
