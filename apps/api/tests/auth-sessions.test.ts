import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { SessionStore } from '../src/auth/sessions.js';
import { openDatabase } from '../src/db/client.js';
import { authSessions, users } from '../src/db/schema.js';
import { TEST_APP_SECRETS, buildAuthApp } from './support/auth-app.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function openStore(path = ':memory:') {
  let time = Date.parse('2026-11-25T00:00:00.000Z');
  const now = () => new Date(time).toISOString();
  const database = openDatabase(path, now);
  closers.push(() => database.close());
  const addUser = (id: string, role: 'owner' | 'member') =>
    database.db
      .insert(users)
      .values({
        id,
        githubId: null,
        login: id,
        name: null,
        avatarUrl: null,
        role,
        createdAt: now(),
      })
      .run();
  return {
    db: database.db,
    store: new SessionStore({ db: database.db, now }),
    addUser,
    advance: (ms: number) => (time += ms),
  };
}

it('stores only the hash of a session ID and finds its user', () => {
  const { db, store, addUser } = openStore();
  addUser('u1', 'member');
  const rawId = store.create('u1');
  const rows = db.select().from(authSessions).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.idHash).toBe(createHash('sha256').update(rawId).digest('hex'));
  expect(rows[0]?.idHash).not.toContain(rawId);
  expect(store.find(rawId)).toEqual({
    id: 'u1',
    login: 'u1',
    name: null,
    avatarUrl: null,
    role: 'member',
  });
  expect(store.find('not-a-session')).toBeNull();
});

it('ends a session 30 days after its last use and refreshes last use hourly', () => {
  const { db, store, addUser, advance } = openStore();
  addUser('u1', 'member');
  const rawId = store.create('u1');
  const lastUsed = () => db.select().from(authSessions).get()?.lastUsedAt;
  const created = lastUsed();
  advance(30 * 60 * 1000);
  expect(store.find(rawId)).not.toBeNull();
  expect(lastUsed()).toBe(created);
  advance(31 * 60 * 1000);
  expect(store.find(rawId)).not.toBeNull();
  expect(lastUsed()).not.toBe(created);
  advance(30 * DAY - 1);
  expect(store.find(rawId)).not.toBeNull();
  advance(30 * DAY + 1);
  expect(store.find(rawId)).toBeNull();
});

it('deletes one session or all of a user and tells listeners', () => {
  const { db, store, addUser } = openStore();
  addUser('u1', 'member');
  addUser('u2', 'member');
  const first = store.create('u1');
  const second = store.create('u1');
  const other = store.create('u2');
  store.delete(first);
  expect(store.find(first)).toBeNull();
  expect(store.find(second)).not.toBeNull();
  const removed: string[] = [];
  store.onUserRemoved((userId) => removed.push(userId));
  store.deleteForUser('u1');
  expect(store.find(second)).toBeNull();
  expect(store.find(other)).not.toBeNull();
  expect(removed).toEqual(['u1']);
  db.delete(users).where(eq(users.id, 'u2')).run();
  expect(store.find(other)).toBeNull();
});

it('lets a signed-in user through and refuses an unknown session', async () => {
  const api = await buildAuthApp();
  closers.push(() => api.close());
  await writeFile(api.appFile, JSON.stringify(TEST_APP_SECRETS), { mode: 0o600 });
  const { store, addUser } = openStore(join(api.directory, 'atlas.sqlite'));
  addUser('u1', 'member');
  const rawId = store.create('u1');
  const signedIn = await api.app.inject({
    url: '/api/v1/projects',
    cookies: { atlas_session: rawId },
  });
  expect(signedIn.statusCode).toBe(200);
  const state = await api.app.inject({
    url: '/api/v1/auth/state',
    cookies: { atlas_session: rawId },
  });
  expect(state.json()).toMatchObject({ setup: 'needs_owner', user: { id: 'u1', role: 'member' } });
  const unknown = await api.app.inject({
    url: '/api/v1/projects',
    cookies: { atlas_session: 'forged' },
  });
  expect(unknown.statusCode).toBe(401);
});
