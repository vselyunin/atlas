import { z } from 'zod';
import { IdSchema } from './common.js';

export const UserRoleSchema = z.enum(['owner', 'member']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserSchema = z.strictObject({
  id: IdSchema,
  login: z.string().min(1),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: UserRoleSchema,
});
export type User = z.infer<typeof UserSchema>;

export const AuthStateResponseSchema = z.strictObject({
  auth: z.enum(['off', 'github']),
  setup: z.enum(['not_needed', 'needed', 'needs_owner', 'done']),
  user: UserSchema.nullable(),
  app: z
    .strictObject({
      name: z.string().min(1),
      account: z.string().min(1),
      installUrl: z.url(),
    })
    .nullable(),
});
export type AuthStateResponse = z.infer<typeof AuthStateResponseSchema>;

export const SetupStartSchema = z.strictObject({
  organization: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,39}$/)
    .optional(),
});
export type SetupStart = z.infer<typeof SetupStartSchema>;

export const SetupStartResponseSchema = z.strictObject({
  action: z.url(),
  manifest: z.string().min(1),
});
export type SetupStartResponse = z.infer<typeof SetupStartResponseSchema>;

export const OwnerCodeSchema = z.strictObject({
  code: z.string().min(1),
});
export type OwnerCode = z.infer<typeof OwnerCodeSchema>;

export const MemberSchema = z.strictObject({
  id: IdSchema,
  login: z.string().min(1),
  name: z.string().nullable(),
  role: UserRoleSchema,
  signedIn: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;

export const MemberListResponseSchema = z.strictObject({
  items: z.array(MemberSchema),
});
export type MemberListResponse = z.infer<typeof MemberListResponseSchema>;

export const MemberCreateSchema = z.strictObject({
  login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
});
export type MemberCreate = z.infer<typeof MemberCreateSchema>;

export const MemberResponseSchema = z.strictObject({
  member: MemberSchema,
});
export type MemberResponse = z.infer<typeof MemberResponseSchema>;
