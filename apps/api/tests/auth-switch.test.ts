import { writeFile } from 'node:fs/promises';
import SQLite from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { BOARD_ORIGIN, TEST_APP_SECRETS, buildAuthApp } from './support/auth-app.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe('readConfig', () => {
  const env = { ATLAS_WORKER_TOKEN: 'token' };

  it('turns sign-in on when ATLAS_AUTH is unset', () => {
    expect(readConfig(env).auth).toEqual({
      appFile: '.atlas/github-app.json',
      githubApiUrl: 'https://api.github.com',
      githubWebUrl: 'https://github.com',
    });
    expect(readConfig({ ...env, ATLAS_AUTH: 'github' }).auth).toBeDefined();
  });

  it('reads the App file and GitHub addresses', () => {
    expect(
      readConfig({
        ...env,
        ATLAS_GITHUB_APP_FILE: '/srv/atlas/app.json',
        ATLAS_GITHUB_API_URL: 'http://127.0.0.1:9000/api',
        ATLAS_GITHUB_WEB_URL: 'http://127.0.0.1:9000',
      }).auth,
    ).toEqual({
      appFile: '/srv/atlas/app.json',
      githubApiUrl: 'http://127.0.0.1:9000/api',
      githubWebUrl: 'http://127.0.0.1:9000',
    });
  });

  it('turns sign-in off only for off', () => {
    expect(readConfig({ ...env, ATLAS_AUTH: 'off' }).auth).toBeUndefined();
  });

  it.each(['', 'OFF', 'none'])('refuses ATLAS_AUTH=%j', (value) => {
    expect(() => readConfig({ ...env, ATLAS_AUTH: value })).toThrow();
  });
});

describe('buildApp without sign-in options', () => {
  it('serves every route and reports sign-in off', async () => {
    const app = await buildApp({
      dbPath: ':memory:',
      workerToken: 'test-token',
      allowedOrigin: BOARD_ORIGIN,
    });
    closers.push(() => app.close());
    expect((await app.inject('/api/v1/projects')).statusCode).toBe(200);
    const state = await app.inject('/api/v1/auth/state');
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({ auth: 'off', setup: 'not_needed', user: null, app: null });
  });
});

describe('buildApp with sign-in on', () => {
  it('reports setup needed and refuses other routes while no App file exists', async () => {
    const api = await buildAuthApp();
    closers.push(() => api.close());
    const state = await api.app.inject('/api/v1/auth/state');
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({ auth: 'github', setup: 'needed', user: null, app: null });
    const projects = await api.app.inject('/api/v1/projects');
    expect(projects.statusCode).toBe(409);
    expect(projects.json()).toMatchObject({ error: { code: 'setup_required' } });
  });

  it('reports needs_owner with an App file and no owner, done once an owner exists', async () => {
    const api = await buildAuthApp();
    closers.push(() => api.close());
    await writeFile(api.appFile, JSON.stringify(TEST_APP_SECRETS), { mode: 0o600 });
    expect((await api.app.inject('/api/v1/auth/state')).json()).toMatchObject({
      setup: 'needs_owner',
    });
    const sqlite = new SQLite(join(api.directory, 'atlas.sqlite'));
    try {
      sqlite
        .prepare(
          "INSERT INTO users (id, githubId, login, role, createdAt) VALUES ('u1', 1, 'octo', 'owner', '2026-11-25T00:00:00.000Z')",
        )
        .run();
    } finally {
      sqlite.close();
    }
    expect((await api.app.inject('/api/v1/auth/state')).json()).toEqual({
      auth: 'github',
      setup: 'done',
      user: null,
      app: null,
    });
  });
});
