import { describe, expect, it } from 'vitest';
import {
  ErrorResponseSchema,
  GitUrlSchema,
  invalidInputError,
  makeOperationFixture,
  makeProjectFixture,
  makeTaskFixture,
  makeVersionFixture,
  makeWorkerFixture,
  OperationResponseSchema,
  ProjectCreateResponseSchema,
  ProjectCreateSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  TaskCreateSchema,
  TaskListResponseSchema,
  TaskMoveSchema,
  TaskPatchSchema,
  TaskResponseSchema,
  ValidationErrorDetailsSchema,
  VersionCreateSchema,
  VersionListResponseSchema,
  VersionResponseSchema,
  WorkerListResponseSchema,
} from '../src/index.js';

describe('HTTP request schemas', () => {
  it('trims titles and defaults only the optional create fields', () => {
    expect(TaskCreateSchema.parse({ title: ' Example ' })).toEqual({
      title: 'Example',
      type: 'task',
      priority: 'medium',
      description: '',
      assigneeId: null,
    });
    expect(TaskCreateSchema.parse({ title: 'Example' }).type).toBe('task');
    expect(TaskCreateSchema.parse({ title: 'Example' }).priority).toBe('medium');
    expect(VersionCreateSchema.parse({ name: ' v0.1  ' })).toEqual({ name: 'v0.1' });
  });

  it('rejects forbidden keys and invalid enum values', () => {
    const validCreate = { title: 'Example' };
    expect(TaskCreateSchema.safeParse({ ...validCreate, status: 'done' }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ ...validCreate, ownerId: 'new' }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ ...validCreate, type: 'ticket' }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ ...validCreate, priority: 'critical' }).success).toBe(
      false,
    );
    expect(
      TaskMoveSchema.safeParse({ expectedRevision: 1, status: 'in_progress', beforeTaskId: null })
        .success,
    ).toBe(false);
  });

  it('requires a positive integer revision and at least one permitted patch change', () => {
    expect(TaskPatchSchema.safeParse({ changes: { title: 'Example' } }).success).toBe(false);
    expect(TaskPatchSchema.safeParse({ expectedRevision: 1, changes: {} }).success).toBe(false);
    expect(
      TaskPatchSchema.safeParse({ expectedRevision: 1, changes: { projectId: 'project:other' } })
        .success,
    ).toBe(false);
    expect(
      TaskPatchSchema.safeParse({ expectedRevision: 1.1, changes: { title: 'Example' } }).success,
    ).toBe(false);
    expect(
      TaskMoveSchema.safeParse({ expectedRevision: 0, status: 'done', beforeTaskId: null }).success,
    ).toBe(false);
    expect(TaskMoveSchema.safeParse({ status: 'done', beforeTaskId: null }).success).toBe(false);
    expect(
      TaskPatchSchema.parse({ expectedRevision: 1, changes: { assigneeId: null } }).changes,
    ).toEqual({ assigneeId: null });
  });

  it('enforces the title, description and relative path limits', () => {
    expect(TaskCreateSchema.safeParse({ title: '  ' }).success).toBe(false);
    expect(
      TaskCreateSchema.safeParse({ title: 'X'.repeat(200), description: 'x'.repeat(100_000) })
        .success,
    ).toBe(true);
    expect(TaskCreateSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
    expect(
      TaskCreateSchema.safeParse({ title: 'Example', description: 'x'.repeat(100_001) }).success,
    ).toBe(false);
    const project = (relativePath: string) => ({
      name: 'Example',
      repository: { mode: 'local', workerId: 'worker', relativePath },
    });
    expect(ProjectCreateSchema.safeParse(project('x'.repeat(1024))).success).toBe(true);
    expect(ProjectCreateSchema.safeParse(project('x'.repeat(1025))).success).toBe(false);
    expect(ProjectCreateSchema.safeParse(project('/workspace/example')).success).toBe(false);
    expect(
      ProjectCreateSchema.safeParse({
        ...project('example'),
        repository: { ...project('example').repository, localPath: '/workspace/example' },
      }).success,
    ).toBe(false);
  });
});

describe('repository URLs', () => {
  it.each([
    'https://example.com/team/repo.git',
    'ssh://git@example.com:2222/team/repo.git',
    'ssh://example.com/team/repo.git',
    'git@example.com:team/repo.git',
  ])('accepts %s', (url) => {
    expect(GitUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    'https://token@example.com/team/repo.git',
    'https://user:password@example.com/team/repo.git',
    'ssh://git:password@example.com/team/repo.git',
    'https://example.com/team/repo.git?token=value',
    'http://example.com/team/repo.git',
    'https:/example.com/team/repo.git',
    'git@:/team/repo.git',
    '/workspace/repo',
  ])('rejects %s', (url) => {
    expect(GitUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe('HTTP response schemas', () => {
  it('validates each response envelope and rejects unknown keys', () => {
    const project = makeProjectFixture();
    const operation = makeOperationFixture();
    const version = makeVersionFixture();
    const worker = makeWorkerFixture();
    const task = makeTaskFixture();
    const cases = [
      [ProjectListResponseSchema, { items: [project] }],
      [ProjectResponseSchema, { project }],
      [ProjectCreateResponseSchema, { project, operation: null }],
      [VersionListResponseSchema, { items: [version] }],
      [VersionResponseSchema, { version }],
      [WorkerListResponseSchema, { items: [worker] }],
      [TaskListResponseSchema, { items: [task] }],
      [TaskResponseSchema, { task }],
      [OperationResponseSchema, { operation }],
    ] as const;
    for (const [schema, response] of cases) {
      expect(schema.safeParse(response).success).toBe(true);
      expect(schema.safeParse({ ...response, extra: true }).success).toBe(false);
    }
    expect(
      TaskResponseSchema.safeParse({ task: { ...task, createdAt: '2026-11-19T00:00:00+03:00' } })
        .success,
    ).toBe(false);
    expect(TaskResponseSchema.safeParse({ task: { ...task, position: -1 } }).success).toBe(false);
  });

  it('maps parsing failures to validated, public error details', () => {
    const parsed = TaskPatchSchema.safeParse({ changes: { title: 'Example' } });
    if (parsed.success) throw new Error('Expected missing expectedRevision to fail validation');

    const response = invalidInputError(parsed.error);
    expect(ErrorResponseSchema.parse(response)).toEqual({
      error: {
        code: 'invalid_input',
        message: 'Invalid input',
        details: [{ path: ['expectedRevision'], code: 'invalid_type' }],
      },
    });
    expect(ValidationErrorDetailsSchema.safeParse(response.error.details).success).toBe(true);
  });
});
