import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SetupStartResponse } from '@atlas/contracts';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { hasOwner } from '../auth/access.js';
import type { OwnerCodePurpose } from '../config.js';
import type { ApiContext, Database, DbTransaction } from '../db/client.js';
import { installation, workers } from '../db/schema.js';
import type { AppFile, AppSecrets } from '../github/app-file.js';
import { GitHubError } from '../github/client.js';
import type { GitHubClient } from '../github/client.js';
import { newAppUrl } from '../github/urls.js';
import { ApiError } from '../http/errors.js';
import { buildManifest, hasExactRights } from './manifest.js';

export type SetupFailure =
  'cancelled' | 'state_invalid' | 'app_public' | 'app_rights' | 'github_failed';

export type SetupServiceOptions = {
  context: ApiContext;
  appFile: AppFile;
  github: GitHubClient;
  boardOrigin: string;
  webUrl: string;
};

// GitHub requires the manifest flow to finish within one hour.
const STATE_LIFETIME_MS = 60 * 60 * 1000;
// Bounds the memory that repeated starts can take; the oldest pending setup is dropped first.
const MAX_PENDING_STATES = 50;
const MARK_KEY = 'setup_mark';
const OWNER_CODE_KEY = 'owner_code';
// Lets a browser run setup again when an owner exists and the App file is missing.
const RECONNECT_KEY = 'reconnect_mark';

const newSecret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();

function matches(expected: Buffer, value: string) {
  const actual = digest(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

class Refused extends Error {
  constructor(readonly reason: SetupFailure) {
    super(`Setup refused: ${reason}`);
  }
}

// The ID of a registered Worker whose workspace root holds the App file, or null. Agents in that
// workspace could read the App's private key.
export function workerExposingAppFile({ db }: ApiContext, appFile: AppFile): string | null {
  const roots = db
    .select({ id: workers.id, workspaceRoot: workers.workspaceRoot })
    .from(workers)
    .where(isNotNull(workers.workspaceRoot))
    .all();
  for (const { id, workspaceRoot } of roots) {
    if (workspaceRoot && appFile.isUnder(workspaceRoot)) return id;
  }
  return null;
}

// Refuses to run with the App file inside a registered Worker's workspace root.
export function assertAppFileOutsideWorkspaces(context: ApiContext, appFile: AppFile) {
  const id = workerExposingAppFile(context, appFile);
  if (id !== null) {
    throw new Error(
      `GitHub App file lies inside the workspace root of Worker ${id}: ${appFile.path}`,
    );
  }
}

// First-run setup: creates the GitHub App through the manifest flow, stores its secrets in the
// App file, and decides which browser may become the owner. It also lets the owner connect a new
// App after the App file was removed. `state` values live in memory only; the marks and the
// owner code are stored as SHA-256 hashes.
export class SetupService {
  // Pending setups by the SHA-256 of their `state`, with the hash of the browser's cookie.
  private readonly pending = new Map<string, { issuedAt: number; cookieHash: Buffer }>();
  private finishing = false;

  constructor(private readonly options: SetupServiceOptions) {}

  start(organization?: string): { response: SetupStartResponse; cookie: string } {
    if (this.options.appFile.read() !== null) {
      throw new ApiError(
        409,
        'setup_done',
        'The GitHub App is already set up. Remove the App file to run setup again.',
      );
    }
    const now = this.now();
    for (const [key, entry] of this.pending) {
      if (now - entry.issuedAt > STATE_LIFETIME_MS) this.pending.delete(key);
    }
    while (this.pending.size >= MAX_PENDING_STATES) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const state = newSecret();
    const cookie = newSecret();
    this.pending.set(digest(state).toString('hex'), { issuedAt: now, cookieHash: digest(cookie) });
    // App names are unique across GitHub; the owner can change the name on GitHub's page.
    const name = `Atlas-${randomBytes(3).toString('hex')}`;
    const manifest = buildManifest(this.options.boardOrigin, name);
    return {
      response: {
        action: `${newAppUrl(this.options.webUrl, organization)}?state=${encodeURIComponent(state)}`,
        manifest: JSON.stringify(manifest),
      },
      cookie,
    };
  }

  async finish(params: {
    code?: string;
    state?: string;
    error?: string;
    cookie?: string;
  }): Promise<{ redirect: string; mark?: string; unexpected?: true }> {
    const board = this.options.boardOrigin;
    try {
      // A `state` is used once, whatever the outcome.
      const entry = params.state === undefined ? undefined : this.take(params.state);
      if (params.error !== undefined) throw new Refused('cancelled');
      if (
        !entry ||
        params.cookie === undefined ||
        !matches(entry.cookieHash, params.cookie) ||
        this.now() - entry.issuedAt > STATE_LIFETIME_MS
      ) {
        throw new Refused('state_invalid');
      }
      if (!params.code) throw new Refused('github_failed');
      // One App per installation: refuse while another callback is finishing or after one did.
      if (this.finishing || this.options.appFile.read() !== null) {
        throw new Refused('state_invalid');
      }
      this.finishing = true;
      let mark: string | undefined;
      try {
        const secrets = await this.verifiedApp(params.code);
        // The mark is stored before the file is written, so a written App file always comes with
        // a mark. An existing owner needs none: they sign in with their own GitHub account.
        mark = hasOwner(this.options.context) ? undefined : this.issueMark();
        try {
          this.options.appFile.write(secrets);
        } catch (error) {
          if (mark !== undefined) this.dropMark();
          throw error;
        }
        // A reconnect is done: its code and mark open nothing once the App file exists.
        if (mark === undefined) this.dropReconnect();
      } finally {
        this.finishing = false;
      }
      return { redirect: `${board}/?setup=created`, ...(mark === undefined ? {} : { mark }) };
    } catch (error) {
      if (error instanceof Refused) {
        return { redirect: `${board}/?setup=failed&reason=${error.reason}` };
      }
      // Anything else (the App file or the database failing) still ends in a redirect. The
      // created App's secrets are not kept; the owner deletes that App on GitHub and starts again.
      return { redirect: `${board}/?setup=failed&reason=github_failed`, unexpected: true };
    }
  }

  private dropMark() {
    try {
      this.options.context.db.delete(installation).where(eq(installation.key, MARK_KEY)).run();
    } catch {
      // Without an App file the mark leads nowhere; the next start removes it.
    }
  }

  private dropReconnect() {
    try {
      this.options.context.db
        .delete(installation)
        .where(inArray(installation.key, [OWNER_CODE_KEY, RECONNECT_KEY]))
        .run();
    } catch {
      // Harmless: both open nothing while the App file exists, and the next start removes them.
    }
  }

  // An owner exists and the App file is missing: the owner code then opens setup again.
  reconnecting(): boolean {
    return hasOwner(this.options.context) && this.options.appFile.read() === null;
  }

  // Trades a correct, unused owner code for a new mark; null otherwise. Before an owner exists
  // the mark is the setup mark, which lets this browser's sign-in become the owner. While
  // reconnecting it is the reconnect mark, which only opens the setup routes; it never makes
  // anyone the owner.
  redeemOwnerCode(code: string): { mark: string; purpose: OwnerCodePurpose } | null {
    const stored = this.storedHash(OWNER_CODE_KEY);
    if (!stored || !matches(stored, code)) return null;
    const owner = hasOwner(this.options.context);
    // A code issued for a reconnect opens nothing once the App file is back.
    if (owner && !this.reconnecting()) return null;
    const purpose: OwnerCodePurpose = owner ? 'reconnect' : 'owner';
    return this.options.context.db.transaction((tx) => {
      tx.delete(installation).where(eq(installation.key, OWNER_CODE_KEY)).run();
      const mark = newSecret();
      this.storeHash(tx, purpose === 'owner' ? MARK_KEY : RECONNECT_KEY, mark);
      return { mark, purpose };
    });
  }

  hasMark(rawMark: string | undefined): boolean {
    if (!rawMark) return false;
    const stored = this.storedHash(MARK_KEY);
    return stored !== null && matches(stored, rawMark);
  }

  // Whether this browser's reconnect mark lets it run setup now.
  hasReconnectMark(rawMark: string | undefined): boolean {
    if (!rawMark || !this.reconnecting()) return false;
    const stored = this.storedHash(RECONNECT_KEY);
    return stored !== null && matches(stored, rawMark);
  }

  // Whether an owner code for a reconnect is waiting to be entered.
  awaitsReconnectCode(): boolean {
    return this.reconnecting() && this.storedHash(OWNER_CODE_KEY) !== null;
  }

  // Called when an owner is created: the marks and the owner code stop working.
  clearOwnerSecrets(): void {
    this.options.context.db
      .delete(installation)
      .where(inArray(installation.key, [MARK_KEY, OWNER_CODE_KEY, RECONNECT_KEY]))
      .run();
  }

  // At start: a new owner code while the App file exists and no owner does, or while an owner
  // exists and the App file is missing (a reconnect). Returns the code to show the person running
  // the API, or null. Stale secrets are removed otherwise. A reconnect mark already given to a
  // browser keeps working across a restart until the App file is written.
  openOwnerCode(): { code: string; purpose: OwnerCodePurpose } | null {
    const owner = hasOwner(this.options.context);
    const appFile = this.options.appFile.read() !== null;
    if (owner === appFile) {
      this.clearOwnerSecrets();
      return null;
    }
    const code = newSecret();
    this.storeHash(this.options.context.db, OWNER_CODE_KEY, code);
    return { code, purpose: owner ? 'reconnect' : 'owner' };
  }

  private take(state: string) {
    const key = digest(state).toString('hex');
    const entry = this.pending.get(key);
    this.pending.delete(key);
    return entry;
  }

  // Exchanges the manifest code and checks with GitHub, using the new key, that the App is the
  // one the manifest described.
  private async verifiedApp(code: string): Promise<AppSecrets> {
    const { github } = this.options;
    try {
      const converted = await github.convertManifest(code);
      const secrets: AppSecrets = {
        appId: converted.appId,
        slug: converted.slug,
        name: converted.name,
        account: converted.account,
        clientId: converted.clientId,
        clientSecret: converted.clientSecret,
        privateKey: converted.privateKey,
      };
      const described = await github.describeApp(secrets);
      if (described.id !== secrets.appId) throw new Refused('github_failed');
      if (described.public) throw new Refused('app_public');
      if (!hasExactRights(described.permissions) || described.events.length > 0) {
        throw new Refused('app_rights');
      }
      return secrets;
    } catch (error) {
      if (error instanceof GitHubError) throw new Refused('github_failed');
      throw error;
    }
  }

  private issueMark(): string {
    const mark = newSecret();
    this.storeHash(this.options.context.db, MARK_KEY, mark);
    return mark;
  }

  private storeHash(db: Database | DbTransaction, key: string, raw: string) {
    const value = digest(raw).toString('hex');
    db.insert(installation)
      .values({ key, value })
      .onConflictDoUpdate({ target: installation.key, set: { value } })
      .run();
  }

  private storedHash(key: string): Buffer | null {
    const row = this.options.context.db
      .select({ value: installation.value })
      .from(installation)
      .where(eq(installation.key, key))
      .get();
    return row ? Buffer.from(row.value, 'hex') : null;
  }

  private now() {
    return Date.parse(this.options.context.now());
  }
}
