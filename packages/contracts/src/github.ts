import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';

export const GithubFullNameSchema = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);

export const GithubConnectionResponseSchema = z.strictObject({
  connection: z.strictObject({
    name: z.string().min(1),
    slug: z.string().min(1),
    account: z.string().min(1),
    manageUrl: z.url(),
    installUrl: z.url(),
  }),
});
export type GithubConnectionResponse = z.infer<typeof GithubConnectionResponseSchema>;

export const GithubRepositorySchema = z.strictObject({
  id: z.int().positive(),
  fullName: GithubFullNameSchema,
  private: z.boolean(),
  defaultBranch: z.string().min(1),
});
export type GithubRepository = z.infer<typeof GithubRepositorySchema>;

export const GithubRepositoryListResponseSchema = z.strictObject({
  items: z.array(GithubRepositorySchema),
});
export type GithubRepositoryListResponse = z.infer<typeof GithubRepositoryListResponseSchema>;

export const GithubLinkSchema = z.strictObject({
  projectId: IdSchema,
  repositoryId: z.int().positive(),
  fullName: GithubFullNameSchema,
  defaultBranch: z.string().min(1),
  accessible: z.boolean(),
  createdAt: TimestampSchema,
});
export type GithubLink = z.infer<typeof GithubLinkSchema>;

export const GithubLinkResponseSchema = z.strictObject({
  link: GithubLinkSchema.nullable(),
});
export type GithubLinkResponse = z.infer<typeof GithubLinkResponseSchema>;

export const GithubLinkCreateSchema = z.strictObject({
  repositoryId: z.int().positive(),
});
export type GithubLinkCreate = z.infer<typeof GithubLinkCreateSchema>;
