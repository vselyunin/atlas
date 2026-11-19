import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Database } from './client.js';

export function migrateDatabase(db: Database) {
  migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)) });
}
