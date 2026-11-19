import { z } from 'zod';

export const LOOPBACK_HOST = '127.0.0.1';

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLocalHost(host: string | undefined) {
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(host)) return false;
  return Number(host.match(/:(\d+)$/)?.[1] ?? 0) <= 65535;
}

const optionsSchema = z.object({
  dbPath: z.string().min(1),
  workerToken: z.string().regex(/^\S+$/, 'A non-empty Worker token without whitespace is required'),
  allowedOrigin: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      localHosts.has(url.hostname) &&
      value === url.origin
    );
  }, 'Expected a loopback Board origin without a path'),
});

export interface ApiOptions extends z.infer<typeof optionsSchema> {
  now?: () => Date;
  logger?: boolean;
}

export function validateOptions(options: ApiOptions) {
  const parsed = optionsSchema.parse(options);
  return {
    ...parsed,
    now: () => (options.now?.() ?? new Date()).toISOString(),
    logger: options.logger ?? false,
  };
}

export function readConfig(env: NodeJS.ProcessEnv) {
  return {
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.ATLAS_API_PORT ?? 4310),
    ...optionsSchema.parse({
      dbPath: env.ATLAS_DB_PATH ?? '.atlas/atlas.sqlite',
      workerToken: env.ATLAS_WORKER_TOKEN,
      allowedOrigin: env.ATLAS_BOARD_ORIGIN ?? 'http://localhost:5173',
    }),
    logger: true,
  };
}
