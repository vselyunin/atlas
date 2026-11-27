import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, prepareConfig } from '../src/config.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atlas-git-host-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const input = (gitHostUrl?: string) => ({
  apiUrl: 'ws://127.0.0.1:4310/api/v1/workers/connect',
  token: 'test-token',
  id: 'atlas:test',
  name: 'Test',
  root: join(directory, 'repos'),
  stateDir: join(directory, 'state'),
  ...(gitHostUrl === undefined ? {} : { gitHostUrl }),
});

it('uses GitHub by default', () => {
  expect(prepareConfig(input()).gitHostUrl).toBe('https://github.com');
});

it.each(['http://127.0.0.1:9', 'https://example.com'])('accepts %s', (url) => {
  expect(prepareConfig(input(url)).gitHostUrl).toBe(url);
});

it('refuses plain http to a host that is not a loopback address', () => {
  expect(() => prepareConfig(input('http://example.com'))).toThrow();
});

it.each(['https://user:secret@example.com', 'ftp://example.com', 'https://example.com/?a=b'])(
  'refuses %s',
  (url) => {
    expect(() => prepareConfig(input(url))).toThrow();
  },
);

it('reads the Git host from ATLAS_GIT_HOST_URL', () => {
  const config = loadConfig({
    ATLAS_WORKER_TOKEN: 'test-token',
    ATLAS_GIT_HOST_URL: 'https://example.com',
  });
  expect(config.gitHostUrl).toBe('https://example.com');
  expect(loadConfig({ ATLAS_WORKER_TOKEN: 'test-token' }).gitHostUrl).toBe('https://github.com');
});
