import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepositoryCloneCommand } from '@atlas/contracts';
import { Journal } from '../src/state/journal.js';
import { cloneRepository } from '../src/repositories/clone.js';

// A failed project cannot be linked again, so the message for a renamed repository tells the
// person to create the project again.

let directory: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'atlas-clone-renamed-')));
  await mkdir(join(directory, 'repos'));
  await mkdir(join(directory, 'state'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('tells the person to create the project again from the new name', async () => {
  const command: RepositoryCloneCommand = {
    protocolVersion: 1,
    messageId: randomUUID(),
    type: 'command.dispatch',
    commandId: randomUUID(),
    payload: {
      kind: 'repository.clone',
      projectId: 'p1',
      relativePath: 'project',
      repository: 'team/project',
    },
  };
  const outcome = await cloneRepository(command, {
    root: join(directory, 'repos'),
    journal: new Journal(join(directory, 'state')),
    // The Git host is never contacted for a grant that names another repository.
    gitHostUrl: 'http://127.0.0.1:9',
    requestCredential: () =>
      Promise.resolve({
        token: 'ghs_unused',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        repository: 'team/renamed',
      }),
    signal: new AbortController().signal,
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status !== 'failed') return;
  expect(outcome.error.code).toBe('repository_renamed');
  expect(outcome.error.message).toContain('team/project is now team/renamed');
  expect(outcome.error.message).toContain('Create the project again');
  expect(outcome.error.message).not.toContain('Link the project again');
});
