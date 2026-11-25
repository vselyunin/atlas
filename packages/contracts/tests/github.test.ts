import { describe, expect, it } from 'vitest';
import {
  GithubConnectionResponseSchema,
  GithubFullNameSchema,
  GithubLinkCreateSchema,
  GithubLinkResponseSchema,
  GithubLinkSchema,
  GithubRepositoryListResponseSchema,
  GithubRepositorySchema,
} from '../src/index.js';

const repository = { id: 1, fullName: 'octo/atlas', private: true, defaultBranch: 'main' };
const link = {
  projectId: 'project:1',
  repositoryId: 1,
  fullName: 'octo/atlas',
  defaultBranch: 'main',
  accessible: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const connection = {
  name: 'Atlas',
  slug: 'atlas',
  account: 'octo',
  manageUrl: 'https://github.com/settings/apps/atlas',
  installUrl: 'https://github.com/apps/atlas/installations/new',
};

const cases: [string, { safeParse: (value: unknown) => { success: boolean } }, object][] = [
  ['GithubConnectionResponse', GithubConnectionResponseSchema, { connection }],
  ['GithubRepository', GithubRepositorySchema, repository],
  ['GithubRepositoryListResponse', GithubRepositoryListResponseSchema, { items: [repository] }],
  ['GithubLink', GithubLinkSchema, link],
  ['GithubLinkResponse', GithubLinkResponseSchema, { link }],
  ['GithubLinkCreate', GithubLinkCreateSchema, { repositoryId: 1 }],
];

describe('github contracts', () => {
  it.each(cases)('%s accepts a valid value', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each(cases)('%s rejects an unknown key', (_name, schema, value) => {
    expect(schema.safeParse({ ...value, extra: 1 }).success).toBe(false);
  });

  it('accepts no link', () => {
    expect(GithubLinkResponseSchema.safeParse({ link: null }).success).toBe(true);
  });

  it('validates full names', () => {
    expect(GithubFullNameSchema.safeParse('octo/atlas.git_x-1').success).toBe(true);
    for (const bad of ['a/b/c', 'a', 'a/b c', 'https://github.com/a/b']) {
      expect(GithubFullNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects non-positive and fractional repository ids', () => {
    expect(GithubLinkCreateSchema.safeParse({ repositoryId: 0 }).success).toBe(false);
    expect(GithubLinkCreateSchema.safeParse({ repositoryId: 1.5 }).success).toBe(false);
  });
});
