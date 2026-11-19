import { z } from 'zod';
import { IdSchema, NameSchema, TimestampSchema } from './common.js';

export const VersionCreateSchema = z.strictObject({ name: NameSchema });

export const VersionSchema = VersionCreateSchema.extend({
  id: IdSchema,
  projectId: IdSchema,
  createdAt: TimestampSchema,
});

export type VersionCreate = z.infer<typeof VersionCreateSchema>;
export type Version = z.infer<typeof VersionSchema>;
