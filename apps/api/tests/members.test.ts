import { writeFileSync } from 'node:fs';
import { MemberListResponseSchema, MemberResponseSchema } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOARD_ORIGIN, buildAuthApp, signIn } from './support/auth-app.js';
import { startGithubStandIn } from './support/github-stand-in.js';
import type { GithubStandIn } from './support/github-stand-in.js';

const MEMBERS = '/api/v1/members';
const OWNER = { id: 101, login: 'the-owner' };

type Api = Awaited<ReturnType<typeof buildAuthApp>>;

let github: GithubStandIn;
let api: Api;
let owner: string;

beforeAll(async () => {
  github = await startGithubStandIn();
});
afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  Object.assign(github.state, { users: {}, authorizeCode: null, failWith: null, requests: [] });
  api = await buildAuthApp(
    {},
    {
      github,
      prepare: ({ appFile }) =>
        writeFileSync(appFile, JSON.stringify(github.secrets), { mode: 0o600 }),
    },
  );
  const traded = await api.app.inject({
    method: 'POST',
    url: '/api/v1/setup/owner-code',
    payload: { code: api.ownerCodes[0] ?? '' },
  });
  const mark = traded.cookies.find((entry) => entry.name === 'atlas_setup_mark')?.value ?? '';
  owner = await signIn(api.app, OWNER, { atlas_setup_mark: mark });
}, 30_000);
afterEach(async () => {
  await api.close();
});

function add(app: FastifyInstance, cookie: string, login: string) {
  return app.inject({ method: 'POST', url: MEMBERS, headers: { cookie }, payload: { login } });
}

function remove(app: FastifyInstance, cookie: string, userId: string) {
  return app.inject({
    method: 'DELETE',
    url: `${MEMBERS}/${userId}`,
    headers: { cookie },
    payload: {},
  });
}

async function list(cookie: string) {
  const response = await api.app.inject({ url: MEMBERS, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return MemberListResponseSchema.parse(response.json()).items;
}

// Tries to sign in and returns where the callback sent the browser.
async function signInOutcome(user: { id: number; login: string }) {
  try {
    await signIn(api.app, user);
    return 'signed_in';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('members', { timeout: 30_000 }, () => {
  it('binds an added login to the first account that signs in with it', async () => {
    const added = await add(api.app, owner, 'Octo-Cat');
    expect(added.statusCode).toBe(201);
    const member = MemberResponseSchema.parse(added.json()).member;
    expect(member).toMatchObject({ login: 'Octo-Cat', role: 'member', signedIn: false });

    const cookie = await signIn(api.app, { id: 7, login: 'octo-cat' });
    expect(
      (await api.app.inject({ url: '/api/v1/projects', headers: { cookie } })).statusCode,
    ).toBe(200);
    const state = await api.app.inject({ url: '/api/v1/auth/state', headers: { cookie } });
    expect(state.json()).toMatchObject({
      user: { id: member.id, login: 'octo-cat', role: 'member' },
    });

    // The entry is bound to ID 7: another account with that login has no access.
    expect(await signInOutcome({ id: 8, login: 'octo-cat' })).toBe(
      `Sign-in failed: ${BOARD_ORIGIN}/?signin=failed&reason=no_access&login=octo-cat`,
    );
    // A renamed account keeps access through its ID.
    expect(await signInOutcome({ id: 7, login: 'octo-cat-renamed' })).toBe('signed_in');

    const items = await list(owner);
    expect(items).toEqual([
      expect.objectContaining({ login: OWNER.login, role: 'owner', signedIn: true }),
      expect.objectContaining({ id: member.id, role: 'member', signedIn: true }),
    ]);
    // Members see the list too.
    expect(await list(cookie)).toEqual(items);
  });

  it('refuses a login that is already a member, in any case', async () => {
    expect((await add(api.app, owner, 'Octo-Cat')).statusCode).toBe(201);
    const again = await add(api.app, owner, 'octo-cat');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'member_exists' } });
    expect((await add(api.app, owner, OWNER.login.toUpperCase())).statusCode).toBe(409);
    expect((await add(api.app, owner, 'not/a login')).statusCode).toBe(400);
  });

  it('keeps member management to the owner', async () => {
    const created = MemberResponseSchema.parse(
      (await add(api.app, owner, 'octo-cat')).json(),
    ).member;
    const member = await signIn(api.app, { id: 7, login: 'octo-cat' });
    const adding = await add(api.app, member, 'another');
    expect(adding.statusCode).toBe(403);
    expect(adding.json()).toMatchObject({ error: { code: 'owner_required' } });
    const ownerId = (await list(owner)).find((item) => item.role === 'owner')?.id ?? '';
    for (const target of [ownerId, created.id]) {
      const removing = await remove(api.app, member, target);
      expect(removing.statusCode).toBe(403);
      expect(removing.json()).toMatchObject({ error: { code: 'owner_required' } });
    }
    expect(await list(owner)).toHaveLength(2);
  });

  it('ends a removed member’s sessions at once', async () => {
    const created = MemberResponseSchema.parse(
      (await add(api.app, owner, 'octo-cat')).json(),
    ).member;
    const member = await signIn(api.app, { id: 7, login: 'octo-cat' });
    const removed = await remove(api.app, owner, created.id);
    expect(removed.statusCode).toBe(204);
    const next = await api.app.inject({ url: '/api/v1/projects', headers: { cookie: member } });
    expect(next.statusCode).toBe(401);
    expect(await list(owner)).toHaveLength(1);
    expect(await signInOutcome({ id: 7, login: 'octo-cat' })).toContain('reason=no_access');
    expect((await remove(api.app, owner, created.id)).statusCode).toBe(404);
  });

  it('does not remove the owner', async () => {
    const ownerId = (await list(owner))[0]?.id ?? '';
    const response = await remove(api.app, owner, ownerId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'owner_not_removable' } });
    expect((await api.app.inject({ url: MEMBERS, headers: { cookie: owner } })).statusCode).toBe(
      200,
    );
  });

  it('answers a CORS preflight from the Board without a session', async () => {
    const response = await api.app.inject({
      method: 'OPTIONS',
      url: `${MEMBERS}/x`,
      headers: {
        origin: BOARD_ORIGIN,
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(BOARD_ORIGIN);
    expect(String(response.headers['access-control-allow-methods'])).toContain('DELETE');
  });
});
