CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  githubId INTEGER UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatarUrl TEXT,
  role TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX users_login ON users(lower(login));
--> statement-breakpoint
CREATE TABLE auth_sessions (
  idHash TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL,
  lastUsedAt TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE installation (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN createdBy TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN createdBy TEXT;
--> statement-breakpoint
ALTER TABLE operations ADD COLUMN kind TEXT NOT NULL DEFAULT 'repository.init';
--> statement-breakpoint
CREATE TABLE github_links (
  projectId TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),
  repositoryId INTEGER NOT NULL,
  fullName TEXT NOT NULL,
  defaultBranch TEXT NOT NULL,
  createdBy TEXT,
  createdAt TEXT NOT NULL
);
