import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, prepareConfig } from '../src/config.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-agent-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function agentFor(extra: NodeJS.ProcessEnv = {}) {
  return prepareConfig(
    loadConfig({
      ATLAS_WORKER_TOKEN: 'test-token',
      ATLAS_WORKSPACE_ROOT: join(dir, 'root'),
      ATLAS_WORKER_STATE_DIR: join(dir, 'state'),
      ...extra,
    }),
  ).agent;
}

describe('agent settings', () => {
  it('defaults when only a token is given', () => {
    expect(agentFor()).toEqual({ command: ['claude'], sandbox: 'required', allowedDomains: [] });
  });

  it('splits the agent command on whitespace', () => {
    expect(agentFor({ ATLAS_AGENT_COMMAND: 'node  /x/agent.mjs --flag' }).command).toEqual([
      'node',
      '/x/agent.mjs',
      '--flag',
    ]);
  });

  it('falls back to the default command when the value is blank', () => {
    expect(agentFor({ ATLAS_AGENT_COMMAND: '   ' }).command).toEqual(['claude']);
    expect(agentFor({ ATLAS_AGENT_COMMAND: '' }).command).toEqual(['claude']);
  });

  it('accepts only known sandbox values', () => {
    expect(agentFor({ ATLAS_AGENT_SANDBOX: 'off' }).sandbox).toBe('off');
    expect(agentFor({ ATLAS_AGENT_SANDBOX: 'required' }).sandbox).toBe('required');
    for (const value of ['OFF', 'false', '']) {
      expect(() => agentFor({ ATLAS_AGENT_SANDBOX: value })).toThrow();
    }
  });

  it('parses allowed domains', () => {
    expect(
      agentFor({ ATLAS_AGENT_ALLOWED_DOMAINS: 'registry.npmjs.org, *.example.com' }).allowedDomains,
    ).toEqual(['registry.npmjs.org', '*.example.com']);
    expect(agentFor({ ATLAS_AGENT_ALLOWED_DOMAINS: '' }).allowedDomains).toEqual([]);
  });

  it('rejects malformed allowed domains', () => {
    for (const value of ['example.com/path', 'exa mple.com', 'https://example.com', 'a.com,b c']) {
      expect(() => agentFor({ ATLAS_AGENT_ALLOWED_DOMAINS: value })).toThrow();
    }
  });

  it('maps the git identity', () => {
    const agent = agentFor({
      ATLAS_AGENT_GIT_NAME: 'Ada',
      ATLAS_AGENT_GIT_EMAIL: 'ada@example.com',
    });
    expect(agent.gitName).toBe('Ada');
    expect(agent.gitEmail).toBe('ada@example.com');
    expect(agentFor().gitName).toBeUndefined();
    expect(agentFor().gitEmail).toBeUndefined();
  });

  it('accepts a literal with only the original six fields', () => {
    const config = prepareConfig({
      apiUrl: 'ws://127.0.0.1:4310/api/v1/workers/connect',
      token: 'test-token',
      id: 'atlas:test',
      name: 'Test',
      root: join(dir, 'root'),
      stateDir: join(dir, 'state'),
    });
    expect(config.agent).toEqual({ command: ['claude'], sandbox: 'required', allowedDomains: [] });
  });
});
