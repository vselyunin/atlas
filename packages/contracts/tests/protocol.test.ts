import { describe, expect, it } from 'vitest';
import {
  ApiToWorkerMessageSchema,
  makeCommandResultFixture,
  makeRepositoryInitCommandFixture,
  WorkerToApiMessageSchema,
} from '../src/index.js';

const envelope = { protocolVersion: 1, messageId: 'message:example' };
const commandEnvelope = { ...envelope, commandId: 'operation:example' };
const register = {
  ...envelope,
  type: 'worker.register',
  payload: {
    workerId: 'atlas:example',
    name: 'Atlas',
    workspaceRoot: '/workspace',
    capabilities: ['repository.init'],
  },
};

const protocolError = {
  ...envelope,
  type: 'protocol.error',
  payload: { code: 'invalid_message', message: 'Invalid message' },
};

describe('worker protocol', () => {
  it('validates all Worker to API variants', () => {
    const messages = [
      register,
      { ...envelope, type: 'worker.heartbeat', payload: { workerId: 'atlas:example' } },
      { ...commandEnvelope, type: 'command.accepted', payload: {} },
      makeCommandResultFixture(),
      ...(['failed', 'needs_attention'] as const).map((status) =>
        makeCommandResultFixture({
          payload: { status, error: { code: 'git', message: 'Git failed' } },
        }),
      ),
      protocolError,
    ];
    for (const message of messages) {
      expect(WorkerToApiMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('validates all API to Worker variants', () => {
    const messages = [
      {
        ...envelope,
        type: 'worker.registered',
        payload: { workerId: 'atlas:example', heartbeatIntervalMs: 10000 },
      },
      makeRepositoryInitCommandFixture(),
      { ...commandEnvelope, type: 'command.result_ack', payload: {} },
      { ...protocolError, commandId: 'operation:example' },
    ];
    for (const message of messages) {
      expect(ApiToWorkerMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('rejects unsupported versions and messages in the wrong direction', () => {
    const dispatch = makeRepositoryInitCommandFixture();
    expect(ApiToWorkerMessageSchema.safeParse({ ...dispatch, protocolVersion: 2 }).success).toBe(
      false,
    );
    expect(WorkerToApiMessageSchema.safeParse({ ...register, protocolVersion: 2 }).success).toBe(
      false,
    );
    expect(WorkerToApiMessageSchema.safeParse(dispatch).success).toBe(false);
    expect(ApiToWorkerMessageSchema.safeParse(register).success).toBe(false);
  });

  it('rejects mismatched payloads, missing command IDs and unknown keys', () => {
    const result = makeCommandResultFixture();
    const dispatch = makeRepositoryInitCommandFixture();
    expect(
      WorkerToApiMessageSchema.safeParse({
        ...result,
        payload: { status: 'succeeded', error: { code: 'git', message: 'Git failed' } },
      }).success,
    ).toBe(false);
    expect(
      WorkerToApiMessageSchema.safeParse({
        ...result,
        payload: { status: 'needs_attention', localPath: '/workspace/repo' },
      }).success,
    ).toBe(false);
    expect(ApiToWorkerMessageSchema.safeParse({ ...dispatch, commandId: undefined }).success).toBe(
      false,
    );
    expect(
      ApiToWorkerMessageSchema.safeParse({
        ...commandEnvelope,
        type: 'command.result_ack',
        payload: { ok: true },
      }).success,
    ).toBe(false);
    expect(WorkerToApiMessageSchema.safeParse({ ...register, extra: true }).success).toBe(false);
    expect(
      WorkerToApiMessageSchema.safeParse({
        ...register,
        payload: { ...register.payload, capabilities: ['repository.init', 'extra'] },
      }).success,
    ).toBe(false);
  });
});
