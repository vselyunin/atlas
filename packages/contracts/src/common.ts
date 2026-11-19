import { z } from 'zod';

export const IdSchema = z.string().min(1);
export const NameSchema = z.string().trim().min(1).max(200);
export const TimestampSchema = z.iso.datetime();
export const RevisionSchema = z.int().min(1);
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/^(?:[\\/]|[a-z]:)/i.test(value) && !value.includes('\0'), {
    message: 'Expected a relative path',
  });

export const ErrorInfoSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
});

export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;
