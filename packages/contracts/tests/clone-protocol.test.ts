import { describe, expect, it } from 'vitest';
import {
  ApiToWorkerMessageSchema,
  CREDENTIAL_GRANT_WINDOW_MS,
  CREDENTIAL_REPLY_TIMEOUT_MS,
  CommandDispatchSchema,
  ProjectCreateSchema,
  ProjectSchema,
  REPOSITORY_CLONE_CAPABILITY,
  WorkerRegisterSchema,
  WorkerToApiMessageSchema,
  makeProjectFixture,
  makeRepositoryCloneCommandFixture,
  makeRepositoryInitCommandFixture,
} from '../src/index.js';

const envelope = { protocolVersion: 1, messageId: 'message:example' };
const commandEnvelope = { ...envelope, commandId: 'operation:example' };

const request = { ...commandEnvelope, type: 'credential.request', payload: {} };
const grant = {
  ...commandEnvelope,
  type: 'credential.grant',
  payload: {
    token: 'ghs_example',
    expiresAt: '2026-11-25T01:00:00.000Z',
    repository: 'team/project',
  },
};
const refusal = {
  ...commandEnvelope,
  type: 'credential.refusal',
  payload: { code: 'not_accessible', message: 'The repository is not accessible' },
};

function register(capabilities: unknown) {
  return {
    ...envelope,
    type: 'worker.register',
    payload: {
      workerId: 'atlas:example',
      name: 'Atlas',
      workspaceRoot: '/workspace',
      capabilities,
    },
  };
}

describe('clone command', () => {
  it('parses init and clone dispatches in the API to Worker union', () => {
    expect(ApiToWorkerMessageSchema.parse(makeRepositoryInitCommandFixture()).type).toBe(
      'command.dispatch',
    );
    const clone = makeRepositoryCloneCommandFixture();
    expect(ApiToWorkerMessageSchema.parse(clone)).toEqual(clone);
    expect(CommandDispatchSchema.parse(clone)).toEqual(clone);
    expect(clone.payload.kind).toBe(REPOSITORY_CLONE_CAPABILITY);
  });

  it('rejects a token in the clone payload', () => {
    const clone = makeRepositoryCloneCommandFixture();
    const withToken = { ...clone, payload: { ...clone.payload, token: 'ghs_example' } };
    expect(ApiToWorkerMessageSchema.safeParse(withToken).success).toBe(false);
  });

  it('rejects a repository that is a URL', () => {
    const clone = makeRepositoryCloneCommandFixture();
    const withUrl = {
      ...clone,
      payload: { ...clone.payload, repository: 'https://github.com/a/b' },
    };
    expect(ApiToWorkerMessageSchema.safeParse(withUrl).success).toBe(false);
  });
});

describe('credential messages', () => {
  it('uses the planned timing values', () => {
    expect(CREDENTIAL_GRANT_WINDOW_MS).toBe(900_000);
    expect(CREDENTIAL_REPLY_TIMEOUT_MS).toBe(30_000);
  });

  it('accepts the request from the Worker only', () => {
    expect(WorkerToApiMessageSchema.safeParse(request).success).toBe(true);
    expect(ApiToWorkerMessageSchema.safeParse(request).success).toBe(false);
    expect(WorkerToApiMessageSchema.safeParse({ ...request, payload: { extra: 1 } }).success).toBe(
      false,
    );
  });

  it.each([grant, refusal])('accepts $type from the API only', (message) => {
    expect(ApiToWorkerMessageSchema.safeParse(message).success).toBe(true);
    expect(WorkerToApiMessageSchema.safeParse(message).success).toBe(false);
  });

  it('requires a command id and a valid repository name in a grant', () => {
    const withoutCommand = { ...grant, commandId: undefined };
    expect(ApiToWorkerMessageSchema.safeParse(withoutCommand).success).toBe(false);
    expect(
      ApiToWorkerMessageSchema.safeParse({
        ...grant,
        payload: { ...grant.payload, repository: 'https://github.com/a/b' },
      }).success,
    ).toBe(false);
  });
});

describe('capabilities', () => {
  it.each([
    [['repository.init']],
    [['repository.init', 'agent.session']],
    [['repository.init', 'agent.session', 'repository.clone']],
  ])('accepts %j', (capabilities) => {
    expect(WorkerRegisterSchema.safeParse(register(capabilities)).success).toBe(true);
  });

  it('rejects clone without sessions', () => {
    expect(
      WorkerRegisterSchema.safeParse(register(['repository.init', 'repository.clone'])).success,
    ).toBe(false);
  });
});

describe('GitHub repository id on project creation', () => {
  const local = { mode: 'local', workerId: 'atlas:example', relativePath: 'project' };

  it('is accepted on a local create form only', () => {
    expect(
      ProjectCreateSchema.safeParse({
        name: 'Example',
        repository: { ...local, githubRepositoryId: 42 },
      }).success,
    ).toBe(true);
    expect(
      ProjectCreateSchema.safeParse({
        name: 'Example',
        repository: {
          mode: 'existing',
          gitUrl: 'https://example.com/team/project.git',
          githubRepositoryId: 42,
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectCreateSchema.safeParse({
        name: 'Example',
        repository: { ...local, githubRepositoryId: 0 },
      }).success,
    ).toBe(false);
  });

  it('is not part of the stored project shape', () => {
    const project = makeProjectFixture();
    expect(
      ProjectSchema.safeParse({
        ...project,
        repository: { ...local, localPath: null, githubRepositoryId: 42 },
      }).success,
    ).toBe(false);
  });
});
