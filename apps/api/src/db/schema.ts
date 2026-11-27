import type {
  Operation,
  Project,
  Repository,
  TaskStatus,
  TaskType,
  Priority,
  UserRole,
  Worker,
} from '@atlas/contracts';
import { getTableColumns, sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const workers = sqliteTable('workers', {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  kind: text().$type<Worker['kind']>().notNull(),
  availability: text().$type<Worker['availability']>().notNull(),
  lastSeenAt: text(),
  workspaceRoot: text(),
  capabilities: text({ mode: 'json' }).$type<string[]>().notNull(),
});

export const projects = sqliteTable('projects', {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  repository: text({ mode: 'json' }).$type<Repository>().notNull(),
  state: text().$type<Project['state']>().notNull(),
  operationId: text(),
  createdBy: text(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

export const versions = sqliteTable(
  'versions',
  {
    id: text().primaryKey().notNull(),
    projectId: text()
      .notNull()
      .references(() => projects.id),
    name: text().notNull(),
    createdAt: text().notNull(),
  },
  (table) => [unique().on(table.projectId, table.name), unique().on(table.projectId, table.id)],
);

export const operations = sqliteTable(
  'operations',
  {
    id: text().primaryKey().notNull(),
    projectId: text()
      .notNull()
      .references(() => projects.id)
      .unique(),
    kind: text().notNull().default('repository.init'),
    workerId: text()
      .notNull()
      .references(() => workers.id),
    state: text().$type<Operation['state']>().notNull(),
    connectionLost: integer({ mode: 'boolean' }).notNull(),
    result: text({ mode: 'json' }).$type<NonNullable<Operation['result']>>(),
    error: text({ mode: 'json' }).$type<NonNullable<Operation['error']>>(),
    workspaceRoot: text().notNull(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (table) => [index('operations_worker_state').on(table.workerId, table.state)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text().primaryKey().notNull(),
    projectId: text().notNull(),
    versionId: text().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    status: text().$type<TaskStatus>().notNull(),
    type: text().$type<TaskType>().notNull(),
    priority: text().$type<Priority>().notNull(),
    assigneeId: text().references(() => workers.id),
    position: integer().notNull(),
    revision: integer().notNull(),
    createdBy: text(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.versionId],
      foreignColumns: [versions.projectId, versions.id],
    }),
    index('tasks_column_order').on(table.projectId, table.versionId, table.status, table.position),
  ],
);

// createdBy is recorded but is not part of the shared contracts; select these to read a row.
function withoutCreatedBy<T extends Record<string, unknown>>(columns: T) {
  return Object.fromEntries(
    Object.entries(columns).filter(([name]) => name !== 'createdBy'),
  ) as Omit<T, 'createdBy'>;
}
export const projectFields = withoutCreatedBy(getTableColumns(projects));
export const taskFields = withoutCreatedBy(getTableColumns(tasks));

export const users = sqliteTable(
  'users',
  {
    id: text().primaryKey().notNull(),
    githubId: integer().unique(),
    login: text().notNull(),
    name: text(),
    avatarUrl: text(),
    role: text().$type<UserRole>().notNull(),
    createdAt: text().notNull(),
  },
  (table) => [uniqueIndex('users_login').on(sql`lower(${table.login})`)],
);

// Only the SHA-256 of a session ID is stored.
export const authSessions = sqliteTable('auth_sessions', {
  idHash: text().primaryKey().notNull(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text().notNull(),
  lastUsedAt: text().notNull(),
});

// Setup secrets kept as hashes: the setup mark and the owner code.
export const installation = sqliteTable('installation', {
  key: text().primaryKey().notNull(),
  value: text().notNull(),
});

export const githubLinks = sqliteTable('github_links', {
  projectId: text()
    .primaryKey()
    .notNull()
    .references(() => projects.id),
  repositoryId: integer().notNull(),
  fullName: text().notNull(),
  defaultBranch: text().notNull(),
  createdBy: text(),
  createdAt: text().notNull(),
});
