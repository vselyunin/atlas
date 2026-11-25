import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SetupStartResponse } from '@atlas/contracts';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { hasOwner } from '../auth/access.js';
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

// Refuses to run with the App file inside a registered Worker's workspace root: agents there
// could read the App's private key.
export function assertAppFileOutsideWorkspaces({ db }: ApiContext, appFile: AppFile) {
  const roots = db
    .select({ id: workers.id, workspaceRoot: workers.workspaceRoot })
    .from(workers)
    .where(isNotNull(workers.workspaceRoot))
    .all();
  for (const { id, workspaceRoot } of roots) {
    if (workspaceRoot && appFile.isUnder(workspaceRoot)) {
      throw new Error(
        `GitHub App file lies inside the workspace root of Worker ${id}: ${appFile.path}`,
      );
    }
  }
}

// First-run setup: creates the GitHub App through the manifest flow, stores its secrets in the
// App file, and decides which browser may become the owner. `state` values live in memory only;
// the setup mark and the owner code are stored as SHA-256 hashes.
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
  }): Promise<{ redirect: string; mark?: string }> {
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
      let mark: string;
      try {
        const secrets = await this.verifiedApp(params.code);
        this.options.appFile.write(secrets);
        mark = this.issueMark();
      } finally {
        this.finishing = false;
      }
      return { redirect: `${board}/?setup=created`, mark };
    } catch (error) {
      if (error instanceof Refused) {
        return { redirect: `${board}/?setup=failed&reason=${error.reason}` };
      }
      throw error;
    }
  }

  // Returns a new setup mark for a correct, unused owner code; null otherwise.
  redeemOwnerCode(code: string): string | null {
    const stored = this.storedHash(OWNER_CODE_KEY);
    if (!stored || !matches(stored, code)) return null;
    return this.options.context.db.transaction((tx) => {
      tx.delete(installation).where(eq(installation.key, OWNER_CODE_KEY)).run();
      const mark = newSecret();
      this.storeHash(tx, MARK_KEY, mark);
      return mark;
    });
  }

  hasMark(rawMark: string | undefined): boolean {
    if (!rawMark) return false;
    const stored = this.storedHash(MARK_KEY);
    return stored !== null && matches(stored, rawMark);
  }

  // Called when an owner is created: the mark and the owner code stop working.
  clearOwnerSecrets(): void {
    this.options.context.db
      .delete(installation)
      .where(inArray(installation.key, [MARK_KEY, OWNER_CODE_KEY]))
      .run();
  }

  // At start: a new owner code while the App file exists and no owner does. Returns the code to
  // show the person running the API, or null. Stale secrets are removed otherwise.
  openOwnerCode(): string | null {
    if (hasOwner(this.options.context) || this.options.appFile.read() === null) {
      this.clearOwnerSecrets();
      return null;
    }
    const code = newSecret();
    this.storeHash(this.options.context.db, OWNER_CODE_KEY, code);
    return code;
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
