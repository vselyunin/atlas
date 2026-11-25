import { randomUUID } from 'node:crypto';
import {
  API_BASE_PATH,
  IdSchema,
  MemberCreateSchema,
  MemberListResponseSchema,
  MemberResponseSchema,
} from '@atlas/contracts';
import type { Member, MemberListResponse, MemberResponse } from '@atlas/contracts';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../db/client.js';
import { users } from '../db/schema.js';
import { ApiError, parseInput } from '../http/errors.js';
import type { SessionStore } from './sessions.js';

const memberFields = {
  id: users.id,
  login: users.login,
  name: users.name,
  role: users.role,
  githubId: users.githubId,
};

// `signedIn`: the entry is bound to a GitHub account, which happens at its first sign-in.
function toMember(row: {
  id: string;
  login: string;
  name: string | null;
  role: Member['role'];
  githubId: number | null;
}): Member {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    role: row.role,
    signedIn: row.githubId !== null,
  };
}

export function listMembers({ db }: ApiContext): Member[] {
  return db
    .select(memberFields)
    .from(users)
    .orderBy(sql`${users.role} = 'owner' DESC`, asc(users.createdAt), asc(users.login))
    .all()
    .map(toMember);
}

// Adds a member by GitHub login. The entry is bound to an account's ID at its first sign-in.
export function addMember({ db, now }: ApiContext, login: string): Member {
  return db.transaction(
    (tx) => {
      const existing = tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.login}) = lower(${login})`)
        .get();
      if (existing)
        throw new ApiError(409, 'member_exists', 'This GitHub login is already a member');
      const row = {
        id: randomUUID(),
        githubId: null,
        login,
        name: null,
        avatarUrl: null,
        role: 'member' as const,
        createdAt: now(),
      };
      tx.insert(users).values(row).run();
      return toMember(row);
    },
    { behavior: 'immediate' },
  );
}

// Removes a member with all their sessions; their open Board sockets close at once.
export function removeMember({ db }: ApiContext, sessions: SessionStore, userId: string): void {
  db.transaction(
    (tx) => {
      const user = tx.select({ role: users.role }).from(users).where(eq(users.id, userId)).get();
      if (!user) throw new ApiError(404, 'member_not_found', 'Member was not found');
      if (user.role === 'owner') {
        throw new ApiError(409, 'owner_not_removable', 'The owner cannot be removed');
      }
      // Sessions go with the user (on delete cascade).
      tx.delete(users).where(eq(users.id, userId)).run();
    },
    { behavior: 'immediate' },
  );
  sessions.deleteForUser(userId);
}

export function registerMemberRoutes(
  app: FastifyInstance,
  context: ApiContext,
  sessions: SessionStore,
) {
  app.get(`${API_BASE_PATH}/members`, (): MemberListResponse =>
    MemberListResponseSchema.parse({ items: listMembers(context) }),
  );
  app.post(`${API_BASE_PATH}/members`, { config: { access: 'owner' } }, (request, reply) => {
    const { login } = parseInput(MemberCreateSchema, request.body);
    const response: MemberResponse = MemberResponseSchema.parse({
      member: addMember(context, login),
    });
    return reply.code(201).send(response);
  });
  app.delete(
    `${API_BASE_PATH}/members/:userId`,
    { config: { access: 'owner' } },
    (request, reply) => {
      const { userId } = parseInput(z.strictObject({ userId: IdSchema }), request.params);
      removeMember(context, sessions, userId);
      return reply.code(204).send();
    },
  );
}
