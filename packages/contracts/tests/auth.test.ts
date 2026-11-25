import { describe, expect, it } from 'vitest';
import {
  AuthStateResponseSchema,
  MemberCreateSchema,
  MemberListResponseSchema,
  MemberResponseSchema,
  MemberSchema,
  OwnerCodeSchema,
  SetupStartResponseSchema,
  SetupStartSchema,
  UserRoleSchema,
  UserSchema,
} from '../src/index.js';

const user = { id: 'user:1', login: 'octo', name: null, avatarUrl: null, role: 'owner' };
const member = { id: 'user:2', login: 'mona', name: 'Mona', role: 'member', signedIn: true };
const app = { name: 'Atlas', account: 'octo', installUrl: 'https://github.com/apps/atlas' };

const objectCases: [string, { safeParse: (value: unknown) => { success: boolean } }, object][] = [
  ['User', UserSchema, user],
  ['AuthStateResponse', AuthStateResponseSchema, { auth: 'github', setup: 'done', user, app }],
  ['SetupStart', SetupStartSchema, { organization: 'my-org' }],
  [
    'SetupStartResponse',
    SetupStartResponseSchema,
    { action: 'https://github.com/settings/apps/new?state=x', manifest: '{}' },
  ],
  ['OwnerCode', OwnerCodeSchema, { code: 'abc' }],
  ['Member', MemberSchema, member],
  ['MemberListResponse', MemberListResponseSchema, { items: [member] }],
  ['MemberCreate', MemberCreateSchema, { login: 'mona' }],
  ['MemberResponse', MemberResponseSchema, { member }],
];

describe('auth contracts', () => {
  it('accepts roles owner and member only', () => {
    expect(UserRoleSchema.safeParse('owner').success).toBe(true);
    expect(UserRoleSchema.safeParse('member').success).toBe(true);
    expect(UserRoleSchema.safeParse('admin').success).toBe(false);
  });

  it.each(objectCases)('%s accepts a valid value', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each(objectCases)('%s rejects an unknown key', (_name, schema, value) => {
    expect(schema.safeParse({ ...value, extra: 1 }).success).toBe(false);
  });

  it('accepts auth off without user or app', () => {
    expect(
      AuthStateResponseSchema.safeParse({
        auth: 'off',
        setup: 'not_needed',
        user: null,
        app: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an organization that is not a GitHub login', () => {
    expect(SetupStartSchema.safeParse({ organization: 'a b' }).success).toBe(false);
  });
});
