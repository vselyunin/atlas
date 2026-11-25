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

const authSchema = z.object({
  appFile: z.string().min(1),
  githubApiUrl: z.url().optional(),
  githubWebUrl: z.url().optional(),
});

// Sign-in with GitHub. Absent means sign-in is off and the API behaves as before sign-in existed.
export interface AuthOptions {
  appFile: string;
  githubApiUrl?: string;
  githubWebUrl?: string;
  ownerCodeSink?: (code: string) => void;
}

export interface ApiOptions extends z.infer<typeof optionsSchema> {
  now?: () => Date;
  logger?: boolean;
  // Sends the log to this stream instead of standard output, and turns the log on.
  logStream?: { write(line: string): void };
  auth?: AuthOptions;
  // How often an open Board session socket checks that its session still exists.
  sessionRecheckMs?: number;
}

const SESSION_RECHECK_MS = 30_000;

export type ResolvedAuthOptions = Required<AuthOptions>;

function resolveAuth(auth: AuthOptions | undefined): ResolvedAuthOptions | undefined {
  if (!auth) return undefined;
  const parsed = authSchema.parse(auth);
  return {
    appFile: parsed.appFile,
    githubApiUrl: parsed.githubApiUrl ?? 'https://api.github.com',
    githubWebUrl: parsed.githubWebUrl ?? 'https://github.com',
    // The person running the API reads the code from its output; it never goes through the log.
    ownerCodeSink:
      auth.ownerCodeSink ??
      ((code) =>
        process.stdout.write(
          `Atlas owner code (enter it on the sign-in page to become the owner): ${code}\n`,
        )),
  };
}

export function validateOptions(options: ApiOptions) {
  const parsed = optionsSchema.parse(options);
  return {
    ...parsed,
    now: () => (options.now?.() ?? new Date()).toISOString(),
    logger: options.logger ?? false,
    logStream: options.logStream,
    auth: resolveAuth(options.auth),
    sessionRecheckMs: z
      .int()
      .positive()
      .parse(options.sessionRecheckMs ?? SESSION_RECHECK_MS),
  };
}

const authModeSchema = z.enum(['github', 'off']);

function readAuth(env: NodeJS.ProcessEnv): AuthOptions | undefined {
  // Any value other than github or off, the empty string included, stops the server at start.
  if (authModeSchema.parse(env.ATLAS_AUTH ?? 'github') === 'off') return undefined;
  return {
    appFile: env.ATLAS_GITHUB_APP_FILE ?? '.atlas/github-app.json',
    githubApiUrl: env.ATLAS_GITHUB_API_URL ?? 'https://api.github.com',
    githubWebUrl: env.ATLAS_GITHUB_WEB_URL ?? 'https://github.com',
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
    auth: readAuth(env),
  };
}
