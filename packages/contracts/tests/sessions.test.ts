import { describe, expect, it } from 'vitest';
import {
  ApiToBoardSessionMessageSchema,
  ApiToWorkerMessageSchema,
  BoardToApiSessionMessageSchema,
  MAX_SESSION_INPUT_CHARS,
  MAX_SESSION_OUTPUT_CHARS,
  MAX_SESSION_PROMPT_CHARS,
  taskSessionPath,
  WorkerToApiMessageSchema,
} from '../src/index.js';

const envelope = { protocolVersion: 1, messageId: 'message:example' };
const ids = { sessionId: 'session:example', runId: 'run:example' };

const register = (capabilities: unknown) => ({
  ...envelope,
  type: 'worker.register',
  payload: {
    workerId: 'atlas:example',
    name: 'Atlas',
    workspaceRoot: '/workspace',
    capabilities,
  },
});

const message = (type: string, payload: Record<string, unknown>) => ({
  ...envelope,
  type,
  payload: { ...ids, ...payload },
});

const startPayload = {
  projectId: 'project:example',
  relativePath: 'repo',
  prompt: 'Do the work',
  cols: 80,
  rows: 24,
};

const apiToWorker = {
  'session.start': startPayload,
  'session.input': { data: 'ls\n' },
  'session.resize': { cols: 100, rows: 30 },
  'session.stop': {},
};

const workerToApi = {
  'session.started': { worktreePath: '/workspace/repo', branch: 'atlas/task' },
  'session.output': { data: 'hello' },
  'session.exit': { exitCode: 0, message: null },
};

const withoutKey = (value: ReturnType<typeof message>, key: string) => ({
  ...value,
  payload: Object.fromEntries(Object.entries(value.payload).filter(([name]) => name !== key)),
});

describe('worker register capabilities', () => {
  it('accepts repository.init with an optional agent.session', () => {
    for (const capabilities of [['repository.init'], ['repository.init', 'agent.session']]) {
      expect(WorkerToApiMessageSchema.safeParse(register(capabilities)).success).toBe(true);
    }
  });

  it('rejects other capability lists', () => {
    for (const capabilities of [['agent.session'], ['agent.session', 'repository.init'], []]) {
      expect(WorkerToApiMessageSchema.safeParse(register(capabilities)).success).toBe(false);
    }
  });
});

describe('session worker messages', () => {
  const cases = [
    ...Object.entries(apiToWorker).map(([type, payload]) => ({
      type,
      payload,
      schema: ApiToWorkerMessageSchema,
    })),
    ...Object.entries(workerToApi).map(([type, payload]) => ({
      type,
      payload,
      schema: WorkerToApiMessageSchema,
    })),
  ];

  for (const { type, payload, schema } of cases) {
    describe(type, () => {
      const valid = message(type, payload);

      it('parses a valid message', () => {
        expect(schema.safeParse(valid).success).toBe(true);
      });

      it('rejects a missing runId', () => {
        expect(schema.safeParse(withoutKey(valid, 'runId')).success).toBe(false);
      });

      it('rejects a missing sessionId', () => {
        expect(schema.safeParse(withoutKey(valid, 'sessionId')).success).toBe(false);
      });

      it('rejects an unknown extra key', () => {
        const extra = { ...valid, payload: { ...valid.payload, extra: true } };
        expect(schema.safeParse(extra).success).toBe(false);
      });
    });
  }

  it('bounds session.input data', () => {
    const input = (data: string) => message('session.input', { data });
    const max = 'a'.repeat(MAX_SESSION_INPUT_CHARS);
    expect(ApiToWorkerMessageSchema.safeParse(input(max)).success).toBe(true);
    expect(ApiToWorkerMessageSchema.safeParse(input(`${max}a`)).success).toBe(false);
  });

  it('bounds session.output data', () => {
    const output = (data: string) => message('session.output', { data });
    const max = 'a'.repeat(MAX_SESSION_OUTPUT_CHARS);
    expect(WorkerToApiMessageSchema.safeParse(output(max)).success).toBe(true);
    expect(WorkerToApiMessageSchema.safeParse(output(`${max}a`)).success).toBe(false);
  });

  it('bounds the session.start prompt', () => {
    const start = (prompt: string) => message('session.start', { ...startPayload, prompt });
    const max = 'a'.repeat(MAX_SESSION_PROMPT_CHARS);
    expect(ApiToWorkerMessageSchema.safeParse(start(max)).success).toBe(true);
    expect(ApiToWorkerMessageSchema.safeParse(start(`${max}a`)).success).toBe(false);
  });
});

describe('board session messages', () => {
  it('requires cols and rows on start and resize', () => {
    for (const type of ['start', 'resize']) {
      const parse = (value: unknown) => BoardToApiSessionMessageSchema.safeParse(value).success;
      expect(parse({ type, cols: 80, rows: 24 })).toBe(true);
      expect(parse({ type, rows: 24 })).toBe(false);
      expect(parse({ type, cols: 80 })).toBe(false);
    }
  });

  it('requires data on input', () => {
    expect(BoardToApiSessionMessageSchema.safeParse({ type: 'input', data: 'x' }).success).toBe(
      true,
    );
    expect(BoardToApiSessionMessageSchema.safeParse({ type: 'input' }).success).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(BoardToApiSessionMessageSchema.safeParse({ type: 'restart' }).success).toBe(false);
  });

  it('accepts exactly the four session states', () => {
    const session = (state: string) => ({
      type: 'session',
      state,
      branch: null,
      worktreePath: null,
      exitCode: null,
      message: null,
      status: 'none',
      reason: 'none',
      since: null,
    });
    for (const state of ['none', 'starting', 'running', 'exited']) {
      expect(ApiToBoardSessionMessageSchema.safeParse(session(state)).success).toBe(true);
    }
    for (const state of ['stopped', 'Running', '']) {
      expect(ApiToBoardSessionMessageSchema.safeParse(session(state)).success).toBe(false);
    }
  });
});

describe('taskSessionPath', () => {
  it('builds the task session path from a UUID', () => {
    const id = '3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c';
    expect(taskSessionPath(id)).toBe(`/api/v1/tasks/${id}/session`);
  });
});
