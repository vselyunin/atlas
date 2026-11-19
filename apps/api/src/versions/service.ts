import { randomUUID } from 'node:crypto';
import type { Version, VersionCreate } from '@atlas/contracts';
import { and, asc, eq } from 'drizzle-orm';
import type { ApiContext, DbTransaction } from '../db/client.js';
import { versions } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { getProject, requireReadyProject } from '../projects/service.js';

export function addVersion(
  tx: DbTransaction,
  projectId: string,
  name: string,
  now: string,
): Version {
  const version = { id: randomUUID(), projectId, name, createdAt: now };
  const inserted = tx
    .insert(versions)
    .values(version)
    .onConflictDoNothing({ target: [versions.projectId, versions.name] })
    .run();
  if (inserted.changes === 0) {
    throw new ApiError(409, 'version_exists', 'This project already has a version with that name');
  }
  return version;
}

export function listVersions(context: ApiContext, projectId: string): Version[] {
  getProject(context.db, projectId);
  return context.db
    .select()
    .from(versions)
    .where(eq(versions.projectId, projectId))
    .orderBy(asc(versions.createdAt), asc(versions.name))
    .all();
}

export function createVersion(
  context: ApiContext,
  projectId: string,
  input: VersionCreate,
): Version {
  return context.db.transaction(
    (tx) => {
      requireReadyProject(tx, projectId);
      return addVersion(tx, projectId, input.name, context.now());
    },
    { behavior: 'immediate' },
  );
}

export function requireVersion(
  db: ApiContext['db'] | DbTransaction,
  projectId: string,
  versionId: string,
) {
  const version = db
    .select()
    .from(versions)
    .where(and(eq(versions.projectId, projectId), eq(versions.id, versionId)))
    .get();
  if (!version)
    throw new ApiError(404, 'version_not_found', 'Version was not found in this project');
  return version;
}
