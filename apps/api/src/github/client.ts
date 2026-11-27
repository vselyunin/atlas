import { GithubFullNameSchema, GithubRepositorySchema } from '@atlas/contracts';
import type { GithubRepository } from '@atlas/contracts';
import { z } from 'zod';
import type { AppSecrets } from './app-file.js';
import { appJwt } from './jwt.js';

export type GitHubErrorCode =
  'unreachable' | 'timeout' | 'rate_limited' | 'unauthorized' | 'not_found' | 'failed';

// Messages name the operation and the outcome only: never a secret, token, code or URL.
export class GitHubError extends Error {
  readonly status: number | null;
  readonly code: GitHubErrorCode;

  constructor(operation: string, code: GitHubErrorCode, status: number | null = null) {
    super(
      `GitHub could not ${operation}: ${code.replace('_', ' ')}${status === null ? '' : ` (${status})`}`,
    );
    this.name = 'GitHubError';
    this.code = code;
    this.status = status;
  }
}

export type GitHubClientOptions = {
  apiUrl: string;
  webUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type InstalledRepository = { installationId: number; repository: GithubRepository };

const DEFAULT_TIMEOUT_MS = 10_000;
const PER_PAGE = 100;
// A safety stop for a GitHub that keeps announcing a next page.
const MAX_PAGES = 1000;

const AccountSchema = z.object({ login: z.string().min(1) });

const ManifestConversionSchema = z.object({
  id: z.int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  owner: AccountSchema,
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  pem: z.string().min(1),
});

const AppSchema = z.object({
  id: z.int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  owner: AccountSchema,
  permissions: z.record(z.string(), z.string()),
  events: z.array(z.string()),
});

const AppOwnerSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  owner: AccountSchema.extend({ type: z.string().optional() }),
});

const AccessTokenSchema = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({ error: z.string() }),
]);

const UserSchema = z.object({
  id: z.int().positive(),
  login: z.string().min(1),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
});

const RepositoryBodySchema = z.object({
  id: z.int().positive(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
});

const InstallationSchema = z.object({ id: z.int().positive() });

const ListedInstallationSchema = InstallationSchema.extend({
  suspended_at: z.string().nullable().optional(),
});

const InstallationRepositoriesSchema = z.object({
  total_count: z.int().nonnegative(),
  repositories: z.array(RepositoryBodySchema),
});

const InstallationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
});

type Request = {
  operation: string;
  method?: 'GET' | 'POST' | 'DELETE';
  url: string;
  authorization?: string;
  body?: unknown;
  json?: boolean;
};

// GitHub's REST and web endpoints that Atlas uses, authenticated as the App, as an installation
// or as a signed-in person. Every failure is a GitHubError.
export class GitHubClient {
  private readonly apiUrl: string;
  private readonly webUrl: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GitHubClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.webUrl = options.webUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async convertManifest(code: string): Promise<AppSecrets & { ownerLogin: string }> {
    const operation = 'convert the App manifest';
    const { body } = await this.request({
      operation,
      method: 'POST',
      url: this.api(`/app-manifests/${encodeURIComponent(code)}/conversions`),
    });
    const app = parse(operation, ManifestConversionSchema, body);
    return {
      appId: app.id,
      slug: app.slug,
      name: app.name,
      account: app.owner.login,
      clientId: app.client_id,
      clientSecret: app.client_secret,
      privateKey: app.pem,
      ownerLogin: app.owner.login,
    };
  }

  async describeApp(secrets: AppSecrets): Promise<{
    id: number;
    slug: string;
    name: string;
    account: string;
    public: boolean;
    permissions: Record<string, string>;
    events: string[];
  }> {
    const operation = 'describe the App';
    const { body } = await this.request({
      operation,
      url: this.api('/app'),
      authorization: this.jwt(secrets),
    });
    const app = parse(operation, AppSchema, body);
    // Without authentication GitHub shows only public Apps.
    const lookup = await this.request({
      operation: 'look up the App',
      url: this.api(`/apps/${encodeURIComponent(app.slug)}`),
      allowNotFound: true,
    });
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      account: app.owner.login,
      public: lookup.status === 200,
      permissions: app.permissions,
      events: app.events,
    };
  }

  // The App as GitHub now reports it: the owner may have renamed it since setup.
  async readApp(secrets: AppSecrets): Promise<{
    slug: string;
    name: string;
    account: string;
    accountType: 'User' | 'Organization';
  }> {
    const operation = 'read the App';
    const { body } = await this.request({
      operation,
      url: this.api('/app'),
      authorization: this.jwt(secrets),
    });
    const app = parse(operation, AppOwnerSchema, body);
    return {
      slug: app.slug,
      name: app.name,
      account: app.owner.login,
      accountType: app.owner.type === 'Organization' ? 'Organization' : 'User',
    };
  }

  authorizeUrl(
    secrets: AppSecrets,
    params: { state: string; codeChallenge: string; redirectUri: string },
  ): string {
    const query = new URLSearchParams({
      client_id: secrets.clientId,
      redirect_uri: params.redirectUri,
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.webUrl}/login/oauth/authorize?${query.toString()}`;
  }

  async exchangeUserCode(
    secrets: AppSecrets,
    params: { code: string; codeVerifier: string; redirectUri: string },
  ): Promise<string> {
    const operation = 'exchange the sign-in code';
    const { body } = await this.request({
      operation,
      method: 'POST',
      url: `${this.webUrl}/login/oauth/access_token`,
      json: true,
      body: {
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      },
    });
    const result = parse(operation, AccessTokenSchema, body);
    // GitHub answers a refused code with status 200 and an error field.
    if ('error' in result) throw new GitHubError(operation, 'unauthorized', 200);
    return result.access_token;
  }

  async getUser(
    userToken: string,
  ): Promise<{ id: number; login: string; name: string | null; avatarUrl: string | null }> {
    const operation = 'read the signed-in account';
    const { body } = await this.request({
      operation,
      url: this.api('/user'),
      authorization: `Bearer ${userToken}`,
    });
    const user = parse(operation, UserSchema, body);
    return {
      id: user.id,
      login: user.login,
      name: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
    };
  }

  async revokeUserToken(secrets: AppSecrets, userToken: string): Promise<void> {
    const basic = Buffer.from(`${secrets.clientId}:${secrets.clientSecret}`).toString('base64');
    try {
      await this.request({
        operation: 'revoke the sign-in token',
        method: 'DELETE',
        url: this.api(`/applications/${encodeURIComponent(secrets.clientId)}/token`),
        authorization: `Basic ${basic}`,
        body: { access_token: userToken },
      });
    } catch {
      // The token expires on its own; revocation is a courtesy.
    }
  }

  async listRepositories(secrets: AppSecrets): Promise<GithubRepository[]> {
    const repositories: GithubRepository[] = [];
    for (const installationId of await this.installationIds(secrets)) {
      await this.withListingToken(secrets, installationId, undefined, async (token) => {
        const authorization = `Bearer ${token}`;
        await this.pages(
          'list repositories',
          '/installation/repositories',
          authorization,
          (body) => {
            const page = parse('list repositories', InstallationRepositoriesSchema, body);
            for (const repository of page.repositories) {
              repositories.push(toRepository('list repositories', repository));
            }
            return page.repositories.length;
          },
        );
      });
    }
    return repositories;
  }

  async findInstallation(
    secrets: AppSecrets,
    fullName: string,
  ): Promise<InstalledRepository | null> {
    const operation = 'find the installation for a repository';
    if (!GithubFullNameSchema.safeParse(fullName).success) return null;
    const [owner = '', name = ''] = fullName.split('/');
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const found = await this.request({
      operation,
      url: this.api(`${path}/installation`),
      authorization: this.jwt(secrets),
      allowNotFound: true,
    });
    if (found.status === 404) return null;
    const installationId = parse(operation, InstallationSchema, found.body).id;
    return this.withListingToken(secrets, installationId, undefined, async (token) => {
      const read = await this.request({
        operation,
        url: this.api(path),
        authorization: `Bearer ${token}`,
        allowNotFound: true,
      });
      if (read.status === 404) return null;
      const repository = toRepository(operation, parse(operation, RepositoryBodySchema, read.body));
      return { installationId, repository };
    });
  }

  async getRepositoryById(
    secrets: AppSecrets,
    repositoryId: number,
  ): Promise<InstalledRepository | null> {
    const operation = 'read a repository';
    // A token restricted to the repository can be minted only by the installation that covers it.
    for (const installationId of await this.installationIds(secrets)) {
      const result = await this.withListingToken(
        secrets,
        installationId,
        repositoryId,
        async (token) => {
          const read = await this.request({
            operation,
            url: this.api(`/repositories/${repositoryId}`),
            authorization: `Bearer ${token}`,
            allowNotFound: true,
          });
          if (read.status === 404) return null;
          const body = parse(operation, RepositoryBodySchema, read.body);
          return { installationId, repository: toRepository(operation, body) };
        },
      );
      if (result) return result;
    }
    return null;
  }

  async mintToken(
    secrets: AppSecrets,
    params: {
      installationId: number;
      repositoryId: number;
      permissions: { contents: 'read' | 'write' };
    },
  ): Promise<{ token: string; expiresAt: string }> {
    const minted = await this.mint(secrets, params.installationId, {
      repository_ids: [params.repositoryId],
      permissions: { contents: params.permissions.contents },
    });
    if (!minted) throw new GitHubError('mint a repository token', 'not_found', 422);
    return minted;
  }

  async revokeToken(token: string): Promise<boolean> {
    try {
      const { status } = await this.request({
        operation: 'revoke a repository token',
        method: 'DELETE',
        url: this.api('/installation/token'),
        authorization: `Bearer ${token}`,
      });
      return status === 204;
    } catch {
      return false;
    }
  }

  private async installationIds(secrets: AppSecrets): Promise<number[]> {
    const operation = 'list installations';
    const ids: number[] = [];
    await this.pages(operation, '/app/installations', this.jwt(secrets), (body) => {
      const page = parse(operation, z.array(ListedInstallationSchema), body);
      // A suspended installation cannot be given tokens.
      for (const installation of page) {
        if (!installation.suspended_at) ids.push(installation.id);
      }
      return page.length;
    });
    return ids;
  }

  // Runs `use` with a short-lived token that may only read metadata, and revokes it afterwards.
  // Returns null without calling `use` when the installation cannot give one: it does not cover
  // the repository (422), is suspended or otherwise refused (403), or was removed (404). A rate
  // limit is still an error.
  private async withListingToken<T>(
    secrets: AppSecrets,
    installationId: number,
    repositoryId: number | undefined,
    use: (token: string) => Promise<T>,
  ): Promise<T | null> {
    let minted: { token: string; expiresAt: string } | null;
    try {
      minted = await this.mint(secrets, installationId, {
        ...(repositoryId === undefined ? {} : { repository_ids: [repositoryId] }),
        permissions: { metadata: 'read' },
      });
    } catch (error) {
      const unusable =
        error instanceof GitHubError &&
        (error.code === 'not_found' || (error.code === 'unauthorized' && error.status === 403));
      if (unusable) return null;
      throw error;
    }
    if (!minted) return null;
    try {
      return await use(minted.token);
    } finally {
      await this.revokeToken(minted.token);
    }
  }

  // Returns null when GitHub refuses the repository selection (422).
  private async mint(
    secrets: AppSecrets,
    installationId: number,
    body: { repository_ids?: number[]; permissions: Record<string, string> },
  ): Promise<{ token: string; expiresAt: string } | null> {
    const operation = 'mint a repository token';
    const minted = await this.request({
      operation,
      method: 'POST',
      url: this.api(`/app/installations/${installationId}/access_tokens`),
      authorization: this.jwt(secrets),
      body,
      allowUnprocessable: true,
    });
    if (minted.status === 422) return null;
    const token = parse(operation, InstallationTokenSchema, minted.body);
    return { token: token.token, expiresAt: token.expires_at };
  }

  // Requests every page of a listing. `take` returns how many items the page held.
  private async pages(
    operation: string,
    path: string,
    authorization: string,
    take: (body: unknown) => number,
  ): Promise<void> {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { body, headers } = await this.request({
        operation,
        url: this.api(`${path}?per_page=${PER_PAGE}&page=${page}`),
        authorization,
      });
      const count = take(body);
      if (count === 0 || !/rel="next"/.test(headers.get('link') ?? '')) return;
    }
    throw new GitHubError(operation, 'failed');
  }

  private jwt(secrets: AppSecrets): string {
    try {
      return `Bearer ${appJwt(secrets, new Date())}`;
    } catch {
      throw new GitHubError('sign as the App', 'unauthorized');
    }
  }

  private api(path: string): string {
    return `${this.apiUrl}${path}`;
  }

  private async request(
    request: Request & { allowNotFound?: boolean; allowUnprocessable?: boolean },
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const headers: Record<string, string> = {
      accept: request.json ? 'application/json' : 'application/vnd.github+json',
      'user-agent': 'atlas',
    };
    if (!request.json) headers['x-github-api-version'] = '2022-11-28';
    if (request.authorization) headers.authorization = request.authorization;
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    let text: string;
    try {
      response = await this.fetch(request.url, {
        method: request.method ?? 'GET',
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new GitHubError(request.operation, timedOut ? 'timeout' : 'unreachable');
    }

    const { status } = response;
    if (status === 404 && request.allowNotFound) {
      return { status, body: null, headers: response.headers };
    }
    if (status === 422 && request.allowUnprocessable) {
      return { status, body: null, headers: response.headers };
    }
    if (status < 200 || status >= 300) {
      throw new GitHubError(request.operation, errorCode(response), status);
    }
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new GitHubError(request.operation, 'failed', status);
      }
    }
    return { status, body, headers: response.headers };
  }
}

function errorCode(response: Response): GitHubErrorCode {
  const { status, headers } = response;
  if (status === 429) return 'rate_limited';
  if (
    status === 403 &&
    (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after'))
  )
    return 'rate_limited';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  return 'failed';
}

function parse<T>(operation: string, schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new GitHubError(operation, 'failed');
  return result.data;
}

function toRepository(
  operation: string,
  body: z.infer<typeof RepositoryBodySchema>,
): GithubRepository {
  return parse(operation, GithubRepositorySchema, {
    id: body.id,
    fullName: body.full_name,
    private: body.private,
    defaultBranch: body.default_branch,
  });
}
