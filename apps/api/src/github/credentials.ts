import { CREDENTIAL_GRANT_WINDOW_MS, REPOSITORY_CLONE_CAPABILITY } from '@atlas/contracts';
import type { CredentialGrant } from '@atlas/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type WebSocket from 'ws';
import type { ApiContext } from '../db/client.js';
import { operations } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { workerExposingAppFile } from '../setup/service.js';
import type { AppFile } from './app-file.js';
import { GitHubError } from './client.js';
import type { GitHubClient } from './client.js';
import { storedLink } from './links.js';
import type { StoredLink } from './links.js';

export type Credential = CredentialGrant['payload'];

// The rights a clone needs. Logged by this name; the token itself is never logged.
const CLONE_RIGHTS = { contents: 'read' } as const;
const CLONE_RIGHTS_LABEL = 'contents:read';

// The Worker waits CREDENTIAL_REPLY_TIMEOUT_MS (30 s) for a reply. GitHub is given at most this
// long, so a slow GitHub ends in a refusal the Worker still receives.
export const GITHUB_GRANT_BUDGET_MS = 20_000;

export type BrokerTimer = { clear(): void };
export type BrokerTimers = { set(callback: () => void, ms: number): BrokerTimer };

const realTimers: BrokerTimers = {
  set(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return { clear: () => clearTimeout(timer) };
  },
};

export type CredentialBrokerOptions = {
  context: ApiContext;
  log: FastifyBaseLogger;
  // Absent while sign-in is off: every request that passes the command checks is refused.
  github?: { appFile: AppFile; client: GitHubClient };
  timers?: BrokerTimers;
  budgetMs?: number;
};

// Why a dispatch stopped being current while GitHub was being asked.
type Ending = 'released' | 'redispatched' | 'expired' | 'closed';

type Dispatch = {
  socket: WebSocket;
  dispatchedAt: number;
  // `requesting` while GitHub is asked: a second request in that time is refused too.
  state: 'open' | 'requesting' | 'granted' | 'expired';
  timer: BrokerTimer;
  ended?: Ending;
};

function refusal(code: string, message: string) {
  return new ApiError(403, code, message);
}

const ENDING_REFUSAL: Record<Ending, () => ApiError> = {
  released: () => refusal('command_finished', 'The command has finished'),
  redispatched: () =>
    refusal('wrong_connection', 'The command was dispatched on another connection'),
  expired: () => refusal('grant_window_closed', 'The time to ask for a credential has passed'),
  closed: () => new ApiError(502, 'github_unavailable', 'The API is stopping'),
};

// Hands a Worker a short-lived token for one repository, read-only, for a clone the API
// dispatched on that same connection, once per dispatch and within the grant window. Everything
// here is in memory: a token is held only until it is revoked, on the command's result, when
// the grant window closes, or when the API stops.
export class CredentialBroker {
  private readonly dispatches = new Map<string, Dispatch>();
  // Tokens handed out per command and not yet revoked. They outlive a re-dispatch: a Worker that
  // reconnected may still be fetching with the token it was given before.
  private readonly held = new Map<string, Set<string>>();
  private readonly timers: BrokerTimers;
  private readonly budgetMs: number;
  private closed = false;

  constructor(private readonly options: CredentialBrokerOptions) {
    this.timers = options.timers ?? realTimers;
    this.budgetMs = options.budgetMs ?? GITHUB_GRANT_BUDGET_MS;
  }

  // Called each time a clone command is sent. The window counts from the latest dispatch, and a
  // grant given for an earlier dispatch does not stop a new one.
  noteDispatch(commandId: string, socket: WebSocket): void {
    if (this.closed) return;
    const previous = this.dispatches.get(commandId);
    if (previous) {
      previous.timer.clear();
      previous.ended = 'redispatched';
    }
    const dispatch: Dispatch = {
      socket,
      dispatchedAt: this.now(),
      state: 'open',
      timer: { clear() {} },
    };
    dispatch.timer = this.timers.set(
      () => this.expire(commandId, dispatch),
      CREDENTIAL_GRANT_WINDOW_MS,
    );
    this.dispatches.set(commandId, dispatch);
  }

  // Grants or refuses. A refusal is an ApiError whose code goes to the Worker.
  async request(commandId: string, workerId: string, socket: WebSocket): Promise<Credential> {
    const logged: { repository: string | null } = { repository: null };
    try {
      const credential = await this.grant(commandId, workerId, socket, logged);
      this.options.log.info(
        { commandId, workerId, repository: credential.repository, rights: CLONE_RIGHTS_LABEL },
        'Granted a repository credential',
      );
      return credential;
    } catch (error) {
      if (!(error instanceof ApiError)) {
        // The error is not logged: it might quote a response.
        this.options.log.error({ commandId, workerId }, 'Unexpected credential broker error');
      }
      const refused =
        error instanceof ApiError
          ? error
          : new ApiError(502, 'github_unavailable', 'The credential could not be issued');
      this.options.log.info(
        {
          commandId,
          workerId,
          repository: logged.repository,
          rights: CLONE_RIGHTS_LABEL,
          code: refused.code,
        },
        'Refused a repository credential',
      );
      throw refused;
    }
  }

  // Revokes every token handed out for the command and forgets it. Called on its result.
  async release(commandId: string): Promise<void> {
    const dispatch = this.dispatches.get(commandId);
    if (dispatch) {
      dispatch.timer.clear();
      dispatch.ended = 'released';
      this.dispatches.delete(commandId);
    }
    await this.revokeHeld(commandId);
  }

  // On API shutdown: revokes what is held, in parallel, each bounded by the GitHub timeout.
  async close(): Promise<void> {
    this.closed = true;
    for (const dispatch of this.dispatches.values()) {
      dispatch.timer.clear();
      dispatch.ended = 'closed';
    }
    this.dispatches.clear();
    const commands = [...this.held.keys()];
    await Promise.allSettled(commands.map((commandId) => this.revokeHeld(commandId)));
  }

  private async grant(
    commandId: string,
    workerId: string,
    socket: WebSocket,
    logged: { repository: string | null },
  ): Promise<Credential> {
    if (this.closed) throw ENDING_REFUSAL.closed();
    const { db } = this.options.context;
    const operation = db
      .select({
        projectId: operations.projectId,
        workerId: operations.workerId,
        kind: operations.kind,
        state: operations.state,
      })
      .from(operations)
      .where(eq(operations.id, commandId))
      .get();
    if (!operation) throw refusal('unknown_command', 'No command has this ID');
    // Says nothing more about another Worker's command.
    if (operation.workerId !== workerId) {
      throw refusal('wrong_connection', 'The command was not dispatched on this connection');
    }
    const link = storedLink(db, operation.projectId);
    logged.repository = link?.fullName ?? null;
    if (operation.state !== 'pending' && operation.state !== 'accepted') {
      throw refusal('command_finished', 'The command has finished');
    }
    if (operation.kind !== REPOSITORY_CLONE_CAPABILITY) {
      throw refusal('wrong_kind', 'This command does not use a credential');
    }
    const dispatch = this.dispatches.get(commandId);
    // Worker identity alone is not enough: all Workers share one token.
    if (!dispatch || dispatch.socket !== socket) {
      throw refusal('wrong_connection', 'The command was not dispatched on this connection');
    }
    if (dispatch.state === 'requesting' || dispatch.state === 'granted') {
      throw refusal('already_granted', 'A credential was already given for this dispatch');
    }
    if (
      dispatch.state === 'expired' ||
      this.now() - dispatch.dispatchedAt > CREDENTIAL_GRANT_WINDOW_MS
    ) {
      this.expire(commandId, dispatch);
      throw ENDING_REFUSAL.expired();
    }
    const { github } = this.options;
    if (!github) {
      throw new ApiError(502, 'github_unavailable', 'GitHub is not available while sign-in is off');
    }
    if (workerExposingAppFile(this.options.context, github.appFile) !== null) {
      throw refusal(
        'app_file_exposed',
        "The GitHub App file lies inside a Worker's workspace; move it before cloning",
      );
    }
    if (!link) {
      throw refusal('repository_not_accessible', 'The project is not linked to a repository');
    }

    dispatch.state = 'requesting';
    try {
      const credential = await this.withinBudget(commandId, this.mint(commandId, link, github));
      if (dispatch.ended || this.dispatches.get(commandId) !== dispatch) {
        await this.drop(commandId, credential.token);
        throw ENDING_REFUSAL[dispatch.ended ?? 'redispatched']();
      }
      dispatch.state = 'granted';
      return credential;
    } catch (error) {
      if (dispatch.state === 'requesting') dispatch.state = 'open';
      throw error;
    }
  }

  // Asks GitHub for the repository's current name and an installation token limited to it and to
  // Contents read. The token is held for revocation as soon as GitHub hands it out.
  private async mint(
    commandId: string,
    link: StoredLink,
    github: NonNullable<CredentialBrokerOptions['github']>,
  ): Promise<Credential> {
    let secrets: ReturnType<AppFile['read']>;
    try {
      secrets = github.appFile.read();
    } catch {
      throw new ApiError(502, 'github_unavailable', 'The GitHub App file is not readable');
    }
    if (!secrets) throw new ApiError(502, 'github_unavailable', 'Atlas is not set up yet');
    try {
      const found = await github.client.getRepositoryById(secrets, link.repositoryId);
      if (!found) {
        throw refusal('repository_not_accessible', 'The GitHub App cannot access this repository');
      }
      const minted = await github.client.mintToken(secrets, {
        installationId: found.installationId,
        repositoryId: link.repositoryId,
        permissions: CLONE_RIGHTS,
      });
      this.hold(commandId, minted.token);
      const expiresAt = Date.parse(minted.expiresAt);
      if (Number.isNaN(expiresAt)) {
        await this.drop(commandId, minted.token);
        throw new ApiError(502, 'github_unavailable', 'GitHub did not answer as expected');
      }
      return {
        token: minted.token,
        expiresAt: new Date(expiresAt).toISOString(),
        repository: found.repository.fullName,
      };
    } catch (error) {
      if (error instanceof GitHubError) {
        // GitHub refuses a token for a repository the installation no longer covers with 422.
        if (error.status === 422) {
          throw refusal(
            'repository_not_accessible',
            'The GitHub App cannot access this repository',
          );
        }
        // GitHubError messages name the operation and outcome only.
        throw new ApiError(502, 'github_unavailable', error.message);
      }
      throw error;
    }
  }

  // Refuses once the budget is spent. A token GitHub hands out after that is revoked at once.
  private async withinBudget(commandId: string, attempt: Promise<Credential>) {
    let timer: BrokerTimer | undefined;
    let late = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = this.timers.set(() => {
        late = true;
        reject(new ApiError(502, 'github_unavailable', 'GitHub did not answer in time'));
      }, this.budgetMs);
    });
    attempt.then(
      (credential) => {
        if (late) void this.drop(commandId, credential.token);
      },
      () => undefined,
    );
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      timer?.clear();
    }
  }

  private expire(commandId: string, dispatch: Dispatch) {
    if (this.dispatches.get(commandId) !== dispatch) return;
    dispatch.timer.clear();
    dispatch.state = 'expired';
    dispatch.ended = 'expired';
    void this.revokeHeld(commandId);
  }

  private hold(commandId: string, token: string) {
    if (this.closed) {
      void this.revoke(token);
      return;
    }
    const tokens = this.held.get(commandId) ?? new Set<string>();
    tokens.add(token);
    this.held.set(commandId, tokens);
  }

  // Revokes one token now, unless a release, the window or shutdown has revoked it already.
  private async drop(commandId: string, token: string) {
    const tokens = this.held.get(commandId);
    if (!tokens?.delete(token)) return;
    if (tokens.size === 0) this.held.delete(commandId);
    await this.revoke(token);
  }

  private async revokeHeld(commandId: string) {
    const tokens = this.held.get(commandId);
    this.held.delete(commandId);
    if (!tokens) return;
    await Promise.all([...tokens].map((token) => this.revoke(token)));
  }

  private async revoke(token: string) {
    const client = this.options.github?.client;
    // revokeToken never throws; a token it cannot revoke expires within an hour.
    if (client && !(await client.revokeToken(token))) {
      this.options.log.warn('GitHub did not confirm a repository credential revocation');
    }
  }

  private now() {
    return Date.parse(this.options.context.now());
  }
}
