CREATE TABLE workers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  availability TEXT NOT NULL,
  lastSeenAt TEXT,
  workspaceRoot TEXT,
  capabilities TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  repository TEXT NOT NULL,
  state TEXT NOT NULL,
  operationId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE versions (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(projectId, name),
  UNIQUE(projectId, id)
);
--> statement-breakpoint
CREATE TABLE operations (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL UNIQUE REFERENCES projects(id),
  workerId TEXT NOT NULL REFERENCES workers(id),
  state TEXT NOT NULL,
  connectionLost INTEGER NOT NULL,
  result TEXT,
  error TEXT,
  workspaceRoot TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX operations_worker_state ON operations(workerId, state);
--> statement-breakpoint
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL,
  versionId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  assigneeId TEXT REFERENCES workers(id),
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY(projectId, versionId) REFERENCES versions(projectId, id)
);
--> statement-breakpoint
CREATE INDEX tasks_column_order ON tasks(projectId, versionId, status, position);
