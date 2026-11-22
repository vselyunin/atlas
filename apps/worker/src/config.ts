import { resolve, relative, isAbsolute, sep } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { z } from 'zod';

const agentSchema = z.object({
  command: z.array(z.string().min(1)).min(1).default(['claude']),
  sandbox: z.enum(['required', 'off']).default('required'),
  allowedDomains: z
    .array(z.string().regex(/^[^\s/:]+$/, 'Use bare host names such as *.example.com'))
    .default([]),
  gitName: z.string().min(1).optional(),
  gitEmail: z.string().min(1).optional(),
});
export type AgentSettings = z.infer<typeof agentSchema>;

const configSchema = z.object({
  apiUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  }, 'Use a local ws:// API URL'),
  token: z.string().regex(/^\S+$/),
  id: z
    .string()
    .min(1)
    .max(200)
    .refine((id) => !id.startsWith('human:')),
  name: z.string().trim().min(1).max(200),
  root: z.string().min(1),
  stateDir: z.string().min(1),
  agent: agentSchema.prefault({}),
});
export type WorkerConfigInput = z.input<typeof configSchema>;
export type WorkerConfig = z.infer<typeof configSchema>;

function splitCommand(value: string | undefined): string[] | undefined {
  const parts = (value ?? '').split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function splitList(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfigInput {
  return configSchema.parse({
    apiUrl: env.ATLAS_API_WS_URL ?? 'ws://127.0.0.1:4310/api/v1/workers/connect',
    token: env.ATLAS_WORKER_TOKEN,
    id: env.ATLAS_WORKER_ID ?? 'atlas:local',
    name: env.ATLAS_WORKER_NAME ?? 'Local Atlas worker',
    root: resolve(env.ATLAS_WORKSPACE_ROOT ?? '.atlas/projects'),
    stateDir: resolve(env.ATLAS_WORKER_STATE_DIR ?? '.atlas/worker'),
    agent: {
      command: splitCommand(env.ATLAS_AGENT_COMMAND),
      sandbox: env.ATLAS_AGENT_SANDBOX,
      allowedDomains: splitList(env.ATLAS_AGENT_ALLOWED_DOMAINS),
      gitName: env.ATLAS_AGENT_GIT_NAME,
      gitEmail: env.ATLAS_AGENT_GIT_EMAIL,
    },
  });
}

export function prepareConfig(input: WorkerConfigInput): WorkerConfig {
  const config = configSchema.parse(input);
  mkdirSync(config.root, { recursive: true });
  mkdirSync(config.stateDir, { recursive: true });
  const root = realpathSync(config.root);
  const stateDir = realpathSync(config.stateDir);
  const rel = relative(root, stateDir);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new Error('Worker state directory must be outside the repository workspace');
  }
  return { ...config, root, stateDir };
}
