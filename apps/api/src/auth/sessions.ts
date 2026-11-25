import { createHash, randomBytes } from 'node:crypto';
import type { User } from '@atlas/contracts';
import { eq } from 'drizzle-orm';
import type { ApiContext } from '../db/client.js';
import { authSessions, users } from '../db/schema.js';

export const SESSION_COOKIE = 'atlas_session';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_USE_REFRESH_MS = 60 * 60 * 1000;

const hashId = (rawId: string) => createHash('sha256').update(rawId).digest('hex');

// Sessions last 30 days from their last use. Only the SHA-256 of a session ID is stored.
export class SessionStore {
  private readonly listeners: ((userId: string) => void)[] = [];

  constructor(private readonly context: ApiContext) {}

  create(userId: string): string {
    const rawId = randomBytes(32).toString('base64url');
    const now = this.context.now();
    this.context.db
      .insert(authSessions)
      .values({ idHash: hashId(rawId), userId, createdAt: now, lastUsedAt: now })
      .run();
    return rawId;
  }

  find(rawId: string): User | null {
    const idHash = hashId(rawId);
    const row = this.context.db
      .select({
        lastUsedAt: authSessions.lastUsedAt,
        id: users.id,
        login: users.login,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: users.role,
      })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(eq(authSessions.idHash, idHash))
      .get();
    if (!row) return null;
    const now = this.context.now();
    const idle = Date.parse(now) - Date.parse(row.lastUsedAt);
    if (idle > SESSION_LIFETIME_MS) {
      this.context.db.delete(authSessions).where(eq(authSessions.idHash, idHash)).run();
      return null;
    }
    if (idle > LAST_USE_REFRESH_MS) {
      this.context.db
        .update(authSessions)
        .set({ lastUsedAt: now })
        .where(eq(authSessions.idHash, idHash))
        .run();
    }
    return {
      id: row.id,
      login: row.login,
      name: row.name,
      avatarUrl: row.avatarUrl,
      role: row.role,
    };
  }

  delete(rawId: string): void {
    this.context.db
      .delete(authSessions)
      .where(eq(authSessions.idHash, hashId(rawId)))
      .run();
  }

  // Ends every session of a user and tells listeners, which close the user's open sockets.
  deleteForUser(userId: string): void {
    this.context.db.delete(authSessions).where(eq(authSessions.userId, userId)).run();
    for (const listener of this.listeners) listener(userId);
  }

  onUserRemoved(listener: (userId: string) => void): void {
    this.listeners.push(listener);
  }
}
