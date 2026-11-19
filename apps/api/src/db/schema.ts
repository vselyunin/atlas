import type {
  Operation,
  Project,
  Repository,
  TaskStatus,
  TaskType,
  Priority,
  Worker,
} from '@atlas/contracts';
import { foreignKey, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

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
