import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepositoryCloneCommand, RepositoryInitCommand } from '@atlas/contracts';
import { cloneRepository } from '../src/repositories/clone.js';
import { initializeRepository } from '../src/repositories/initialize.js';
import { canChangeMode, workspaceProblem } from '../src/repositories/permissions.js';
import type { ChangeMode } from '../src/repositories/permissions.js';
import { Journal } from '../src/state/journal.js';

// Stands in for a Windows drive under WSL, where only the mount's owner may change a mode.
const refuse: ChangeMode = () =>
  Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));

let directory: string;
let root: string;
let journal: Journal;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-permissions-')));
  root = join(directory, 'repos');
  const state = join(directory, 'state');
  await mkdir(root);
  await mkdir(state);
  journal = new Journal(state);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const envelope = () => ({
  protocolVersion: 1 as const,
  messageId: randomUUID(),
  type: 'command.dispatch' as const,
  commandId: randomUUID(),
});

it('refuses a new repository where modes cannot be changed and leaves no folder', async () => {
  const command: RepositoryInitCommand = {
    ...envelope(),
    payload: { kind: 'repository.init', projectId: 'p1', relativePath: 'example' },
  };
  const outcome = await initializeRepository(command, { root, journal, changeMode: refuse });

  expect(outcome).toMatchObject({ status: 'failed', error: { code: 'workspace_permissions' } });
  const message = outcome.status === 'succeeded' ? '' : outcome.error.message;
  expect(message).toContain(root);
  expect(message).toContain('docs/development/local-setup.md');
  expect(message).toContain('No folder was created.');
  expect(await readdir(root)).toEqual([]);
  expect(journal.get(command.commandId)).toMatchObject({ stage: 'finished', outcome });

  // The name stays free: the same folder works once the workspace allows mode changes.
  const again: RepositoryInitCommand = { ...command, ...envelope() };
  expect(await initializeRepository(again, { root, journal })).toEqual({
    status: 'succeeded',
    localPath: join(root, 'example'),
  });
});

it('refuses a clone the same way, before it asks for a credential', async () => {
  const command: RepositoryCloneCommand = {
    ...envelope(),
    payload: {
      kind: 'repository.clone',
      projectId: 'p1',
      relativePath: 'project',
      repository: 'team/project',
    },
  };
  let asked = false;
  const outcome = await cloneRepository(command, {
    root,
    journal,
    changeMode: refuse,
    gitHostUrl: 'https://github.com',
    requestCredential: () => {
      asked = true;
      return Promise.reject(new Error('not expected'));
    },
    signal: new AbortController().signal,
  });

  expect(outcome).toMatchObject({ status: 'failed', error: { code: 'workspace_permissions' } });
  expect(asked).toBe(false);
  expect(await readdir(root)).toEqual([]);
  expect(journal.get(command.commandId)).toMatchObject({ stage: 'finished', outcome });
});

it('reports another failure of the mode change as an ordinary failed command', async () => {
  const command: RepositoryInitCommand = {
    ...envelope(),
    payload: { kind: 'repository.init', projectId: 'p1', relativePath: 'example' },
  };
  const broken: ChangeMode = () =>
    Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }));
  const outcome = await initializeRepository(command, { root, journal, changeMode: broken });

  expect(outcome).toMatchObject({ status: 'failed', error: { code: 'EIO' } });
  // As with any other failure after the folder was made, the folder is preserved.
  expect(await readdir(root)).toEqual(['example']);
});

it('tells whether a folder allows mode changes', async () => {
  expect(await canChangeMode(root)).toBe(true);
  expect(await canChangeMode(root, refuse)).toBe(false);
});

it('checks a workspace with a folder it removes again', async () => {
  expect(await workspaceProblem(root)).toBeNull();
  expect(await readdir(root)).toEqual([]);

  const problem = await workspaceProblem(root, refuse);
  expect(problem).toContain(root);
  expect(problem).toContain('Workspace on a Windows drive');
  expect(await readdir(root)).toEqual([]);

  // A workspace that cannot be written at all is not this problem; the commands report it.
  expect(await workspaceProblem(join(root, 'missing'), refuse)).toBeNull();
});
