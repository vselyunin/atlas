import { HUMAN_WORKER_ID } from '@atlas/contracts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import SQLite from 'better-sqlite3';
import * as schema from './schema.js';
import { migrateDatabase } from './migrate.js';

export function openDatabase(path: string, now: () => string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new SQLite(path);
  try {
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrateDatabase(db);
    db.transaction((tx) => {
      tx.insert(schema.workers)
        .values({
          id: HUMAN_WORKER_ID,
          name: 'Vladi',
          kind: 'human',
          availability: 'not_applicable',
          lastSeenAt: null,
          workspaceRoot: null,
          capabilities: [],
        })
        .onConflictDoNothing()
        .run();
      tx.update(schema.workers)
        .set({ availability: 'offline' })
        .where(and(eq(schema.workers.kind, 'atlas'), eq(schema.workers.availability, 'online')))
        .run();
      tx.update(schema.operations)
        .set({ connectionLost: true, updatedAt: now() })
        .where(
          and(
            inArray(schema.operations.state, ['pending', 'accepted']),
            eq(schema.operations.connectionLost, false),
          ),
        )
        .run();
    });
    return { db, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type Database = ReturnType<typeof openDatabase>['db'];
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export interface ApiContext {
  db: Database;
  now: () => string;
}
