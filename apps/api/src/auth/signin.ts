import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { API_BASE_PATH } from '@atlas/contracts';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { ApiContext } from '../db/client.js';
import { users } from '../db/schema.js';
import type { AppFile } from '../github/app-file.js';
import { GitHubError } from '../github/client.js';
import type { GitHubClient } from '../github/client.js';
import { ApiError } from '../http/errors.js';
import type { SetupService } from '../setup/service.js';
import { hasOwner } from './access.js';
import type { SessionStore } from './sessions.js';

export type SignInFailure = 'cancelled' | 'state_invalid' | 'no_access' | 'github_failed';

export type SignInServiceOptions = {
  context: ApiContext;
  appFile: AppFile;
  github: GitHubClient;
  sessions: SessionStore;
  setup: SetupService;
  boardOrigin: string;
};

export const SIGNIN_PATH = `${API_BASE_PATH}/auth/github`;
// The `state` and the PKCE verifier live in the browser's cookie for ten minutes.
export const SIGNIN_LIFETIME_MS = 10 * 60 * 1000;
// Bounds the memory that repeated starts can take; the oldest pending sign-in is dropped first.
const MAX_PENDING = 100;

const newSecret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();

function sameSecret(a: string, b: string) {
  return timingSafeEqual(digest(a), digest(b));
}

class Refused extends Error {
  constructor(
    readonly reason: SignInFailure,
    readonly login?: string,
  ) {
    super(`Sign-in refused: ${reason}`);
  }
}

type GitHubAccount = Awaited<ReturnType<GitHubClient['getUser']>>;

// Sign-in with GitHub: authorization code with PKCE and a `state` bound to the browser. The
// GitHub token is used once to read the account and then revoked; it is never stored. Server
// memory keeps only the hashes of pending `state` values, so each is used once.
export class SignInService {
  private readonly pending = new Map<string, number>();
  readonly redirectUri: string;

  constructor(private readonly options: SignInServiceOptions) {
    this.redirectUri = `${options.boardOrigin}${SIGNIN_PATH}/callback`;
  }

  // Returns GitHub's authorize address and the cookie value that binds it to this browser.
  start(): { redirect: string; cookie: string } {
    const secrets = this.options.appFile.read();
    if (!secrets) throw new ApiError(409, 'setup_required', 'Atlas is not set up yet');
    const now = this.now();
    for (const [key, issuedAt] of this.pending) {
      if (now - issuedAt > SIGNIN_LIFETIME_MS) this.pending.delete(key);
    }
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const state = newSecret();
    const verifier = newSecret();
    this.pending.set(digest(state).toString('hex'), now);
    const redirect = this.options.github.authorizeUrl(secrets, {
      state,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      redirectUri: this.redirectUri,
    });
    return { redirect, cookie: `${state}.${verifier}` };
  }

  // Never throws: every outcome is a redirect to the Board. `session` is the new session ID.
  async finish(params: {
    code?: string;
    state?: string;
    error?: string;
    cookie?: string;
    mark?: string;
    currentSession?: string;
  }): Promise<{ redirect: string; session?: string; unexpected?: true }> {
    const board = this.options.boardOrigin;
    try {
      // A `state` is used once, whatever the outcome.
      const issuedAt = params.state === undefined ? undefined : this.take(params.state);
      if (params.error !== undefined) throw new Refused('cancelled');
      const [cookieState, verifier] = (params.cookie ?? '').split('.');
      if (
        issuedAt === undefined ||
        params.state === undefined ||
        !cookieState ||
        !verifier ||
        !sameSecret(cookieState, params.state) ||
        this.now() - issuedAt > SIGNIN_LIFETIME_MS
      ) {
        throw new Refused('state_invalid');
      }
      if (!params.code) throw new Refused('github_failed');
      const account = await this.readAccount(params.code, verifier);
      const session = this.admit(account, params.mark);
      // A sign-in replaces the session this browser had; its ID is never reused.
      if (params.currentSession) this.options.sessions.delete(params.currentSession);
      return { redirect: `${board}/`, session };
    } catch (error) {
      if (error instanceof Refused) {
        const query = new URLSearchParams({ signin: 'failed', reason: error.reason });
        if (error.login !== undefined) query.set('login', error.login);
        return { redirect: `${board}/?${query.toString()}` };
      }
      return { redirect: `${board}/?signin=failed&reason=github_failed`, unexpected: true };
    }
  }

  // Exchanges the code with the verifier, reads the account, and revokes the token.
  private async readAccount(code: string, verifier: string): Promise<GitHubAccount> {
    const { github, appFile } = this.options;
    const secrets = appFile.read();
    if (!secrets) throw new Refused('github_failed');
    try {
      const token = await github.exchangeUserCode(secrets, {
        code,
        codeVerifier: verifier,
        redirectUri: this.redirectUri,
      });
      try {
        return await github.getUser(token);
      } finally {
        // Best effort, and never a reason to fail the sign-in.
        await github.revokeUserToken(secrets, token);
      }
    } catch (error) {
      if (error instanceof GitHubError) throw new Refused('github_failed');
      throw error;
    }
  }

  // Decides in one transaction whether the account may sign in, and creates its session.
  private admit(account: GitHubAccount, mark: string | undefined): string {
    const { context, sessions, setup } = this.options;
    const profile = { name: account.name, avatarUrl: account.avatarUrl };
    return context.db.transaction(
      (tx) => {
        const known = tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.githubId, account.id))
          .get();
        if (known) {
          // Keeps the login GitHub reports, unless another entry already holds it.
          const taken = tx
            .select({ id: users.id })
            .from(users)
            .where(
              and(sql`lower(${users.login}) = lower(${account.login})`, ne(users.id, known.id)),
            )
            .get();
          tx.update(users)
            .set(taken ? profile : { ...profile, login: account.login })
            .where(eq(users.id, known.id))
            .run();
          return sessions.create(known.id);
        }
        // The first owner: only while no owner exists, and only with the setup mark. The mark
        // and the owner code are retired in this same transaction.
        if (!hasOwner(context)) {
          if (!setup.hasMark(mark)) throw new Refused('no_access', account.login);
          const id = randomUUID();
          tx.insert(users)
            .values({
              id,
              githubId: account.id,
              login: account.login,
              ...profile,
              role: 'owner',
              createdAt: context.now(),
            })
            .run();
          setup.clearOwnerSecrets();
          return sessions.create(id);
        }
        // A member the owner added by login is bound to this account's ID at first sign-in.
        const invited = tx
          .select({ id: users.id })
          .from(users)
          .where(and(isNull(users.githubId), sql`lower(${users.login}) = lower(${account.login})`))
          .get();
        if (!invited) throw new Refused('no_access', account.login);
        tx.update(users)
          .set({ githubId: account.id, login: account.login, ...profile })
          .where(eq(users.id, invited.id))
          .run();
        return sessions.create(invited.id);
      },
      { behavior: 'immediate' },
    );
  }

  private take(state: string) {
    const key = digest(state).toString('hex');
    const issuedAt = this.pending.get(key);
    this.pending.delete(key);
    return issuedAt;
  }

  private now() {
    return Date.parse(this.options.context.now());
  }
}
