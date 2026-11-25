import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppSecrets } from '../../src/github/app-file.js';

// A loopback stand-in for the parts of GitHub's REST and web endpoints that Atlas uses.
// No test talks to github.com; every test that needs GitHub starts one of these.

export type StandInUser = {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
};

export type StandInRepository = {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
};

export type StandInInstallation = {
  id: number;
  account: string;
  // A suspended installation is listed with `suspended_at` and refuses tokens with 403.
  suspended?: boolean;
  // Forces the token request to fail: 403 or 404 as GitHub answers for an installation that is
  // unusable or was removed after listing, or an exhausted rate limit.
  mintFailure?: 403 | 404 | 'rate_limited';
};

export type StandInInstallationToken = {
  token: string;
  installationId: number;
  repositoryIds: number[] | null;
  permissions: Record<string, string>;
  expiresAt: string;
};

export type StandInRequest = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
};

export type StandInState = {
  // Sign-in codes GitHub would hand back after the authorize page, mapped to the person.
  users: Record<string, StandInUser>;
  // The code the authorize page redirects back with; null shows a page instead of redirecting.
  authorizeCode: string | null;
  installations: StandInInstallation[];
  repositories: StandInRepository[];
  appPublic: boolean;
  appPermissions: Record<string, string>;
  appEvents: string[];
  // Codes accepted once by the manifest conversion.
  manifestCodes: string[];
  failWith: null | 500 | 403 | 'hang';
  // The App owner's account type, as GitHub reports it on `GET /app`.
  appOwnerType?: 'User' | 'Organization';
  // Fails only the matching requests with this status; others are answered normally.
  failWhen?: (request: StandInRequest) => 500 | null;
  requests: StandInRequest[];
  // Tokens the stand-in has issued and not yet revoked.
  userTokens: Map<string, string>;
  installationTokens: Map<string, StandInInstallationToken>;
};

export type GithubStandIn = {
  apiUrl: string;
  webUrl: string;
  secrets: AppSecrets;
  state: StandInState;
  close(): Promise<void>;
};

const API_PREFIX = '/api';
const PAGE_LIMIT = 100;

let keyPair: { privateKey: string; publicKey: KeyObject } | undefined;
function appKeyPair() {
  // Generating an RSA key takes a moment, so all stand-ins in a test process share one.
  if (!keyPair) {
    const generated = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    keyPair = { privateKey: generated.privateKey, publicKey: createPublicKey(generated.publicKey) };
  }
  return keyPair;
}

export async function startGithubStandIn(): Promise<GithubStandIn> {
  const keys = appKeyPair();
  const secrets: AppSecrets = {
    appId: 4242,
    slug: 'atlas-stand-in',
    name: 'Atlas stand-in',
    account: 'octo-org',
    clientId: 'Iv1.standin',
    clientSecret: `stand-in-secret-${randomBytes(8).toString('hex')}`,
    privateKey: keys.privateKey,
  };
  const state: StandInState = {
    users: {},
    authorizeCode: null,
    installations: [{ id: 1, account: secrets.account }],
    repositories: [],
    appPublic: false,
    appPermissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    appEvents: [],
    manifestCodes: [],
    failWith: null,
    requests: [],
    userTokens: new Map(),
    installationTokens: new Map(),
  };
  const usedCodes = new Set<string>();
  const challenges = new Map<string, string>();
  let origin = '';

  function send(response: ServerResponse, status: number, body?: unknown, headers = {}) {
    response.writeHead(status, {
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  }

  function verifyJwt(authorization: string | null): boolean {
    const match = /^Bearer (.+)$/.exec(authorization ?? '');
    const parts = match?.[1]?.split('.') ?? [];
    if (parts.length !== 3) return false;
    const [header, payload, signature] = parts as [string, string, string];
    try {
      const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString()) as {
        alg?: unknown;
      };
      if (decodedHeader.alg !== 'RS256') return false;
      const valid = verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        keys.publicKey,
        Buffer.from(signature, 'base64url'),
      );
      if (!valid) return false;
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
        iss?: unknown;
        iat?: unknown;
        exp?: unknown;
      };
      const now = Math.floor(Date.now() / 1000);
      return (
        String(claims.iss) === String(secrets.appId) &&
        typeof claims.iat === 'number' &&
        typeof claims.exp === 'number' &&
        claims.iat <= now + 60 &&
        claims.exp > now &&
        claims.exp - claims.iat <= 600
      );
    } catch {
      return false;
    }
  }

  function installationToken(authorization: string | null) {
    const match = /^(?:Bearer|token) (.+)$/.exec(authorization ?? '');
    const token = match?.[1] ? state.installationTokens.get(match[1]) : undefined;
    if (!token || Date.parse(token.expiresAt) <= Date.now()) return undefined;
    return token;
  }

  function canSee(token: StandInInstallationToken, repository: StandInRepository) {
    return (
      repository.installationId === token.installationId &&
      (token.repositoryIds === null || token.repositoryIds.includes(repository.id))
    );
  }

  function repositoryBody(repository: StandInRepository) {
    const [owner = ''] = repository.fullName.split('/');
    return {
      id: repository.id,
      name: repository.fullName.split('/')[1],
      full_name: repository.fullName,
      owner: { login: owner },
      private: repository.private,
      default_branch: repository.defaultBranch,
    };
  }

  function page<T>(url: URL, items: T[]) {
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 30) || 30, PAGE_LIMIT);
    const number = Math.max(Number(url.searchParams.get('page') ?? 1) || 1, 1);
    const slice = items.slice((number - 1) * perPage, number * perPage);
    const headers: Record<string, string> = {};
    if (number * perPage < items.length) {
      const next = new URL(url.href);
      next.searchParams.set('page', String(number + 1));
      next.searchParams.set('per_page', String(perPage));
      headers.link = `<${origin}${next.pathname}${next.search}>; rel="next"`;
    }
    return { slice, headers };
  }

  function handleApi(
    method: string,
    path: string,
    url: URL,
    body: unknown,
    authorization: string | null,
    response: ServerResponse,
  ) {
    const fields = (body ?? {}) as Record<string, unknown>;
    let match: RegExpExecArray | null;

    if (method === 'POST' && (match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path))) {
      const code = decodeURIComponent(match[1] ?? '');
      const index = state.manifestCodes.indexOf(code);
      if (index === -1) return send(response, 404, { message: 'Not Found' });
      state.manifestCodes.splice(index, 1);
      return send(response, 201, {
        id: secrets.appId,
        slug: secrets.slug,
        name: secrets.name,
        owner: { login: secrets.account },
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
        webhook_secret: null,
        pem: secrets.privateKey,
      });
    }

    if (method === 'GET' && (match = /^\/apps\/([^/]+)$/.exec(path))) {
      if (state.appPublic && match[1] === secrets.slug) {
        return send(response, 200, { id: secrets.appId, slug: secrets.slug, name: secrets.name });
      }
      return send(response, 404, { message: 'Not Found' });
    }

    if (method === 'GET' && path === '/user') {
      const bearer = /^(?:Bearer|token) (.+)$/.exec(authorization ?? '');
      const code = bearer?.[1] ? state.userTokens.get(bearer[1]) : undefined;
      const user = code === undefined ? undefined : state.users[code];
      if (!user) return send(response, 401, { message: 'Bad credentials' });
      return send(response, 200, {
        id: user.id,
        login: user.login,
        name: user.name,
        avatar_url: user.avatarUrl,
      });
    }

    if (method === 'DELETE' && (match = /^\/applications\/([^/]+)\/token$/.exec(path))) {
      const expected = `Basic ${Buffer.from(`${secrets.clientId}:${secrets.clientSecret}`).toString('base64')}`;
      if (match[1] !== secrets.clientId || authorization !== expected) {
        return send(response, 404, { message: 'Not Found' });
      }
      const token = typeof fields.access_token === 'string' ? fields.access_token : '';
      if (!state.userTokens.delete(token)) return send(response, 404, { message: 'Not Found' });
      return send(response, 204);
    }

    if (path === '/installation/repositories' && method === 'GET') {
      const token = installationToken(authorization);
      if (!token) return send(response, 401, { message: 'Bad credentials' });
      const visible = state.repositories.filter((repository) => canSee(token, repository));
      const { slice, headers } = page(url, visible);
      return send(
        response,
        200,
        { total_count: visible.length, repositories: slice.map(repositoryBody) },
        headers,
      );
    }

    if (path === '/installation/token' && method === 'DELETE') {
      const token = installationToken(authorization);
      if (!token) return send(response, 401, { message: 'Bad credentials' });
      state.installationTokens.delete(token.token);
      return send(response, 204);
    }

    if (method === 'GET' && (match = /^\/repositories\/(\d+)$/.exec(path))) {
      const token = installationToken(authorization);
      if (!token) return send(response, 401, { message: 'Bad credentials' });
      const repository = state.repositories.find(
        (candidate) => candidate.id === Number(match?.[1]) && canSee(token, candidate),
      );
      if (!repository) return send(response, 404, { message: 'Not Found' });
      return send(response, 200, repositoryBody(repository));
    }

    if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path))) {
      const token = installationToken(authorization);
      if (!token) return send(response, 401, { message: 'Bad credentials' });
      const fullName = `${match[1]}/${match[2]}`.toLowerCase();
      const repository = state.repositories.find(
        (candidate) => candidate.fullName.toLowerCase() === fullName && canSee(token, candidate),
      );
      if (!repository) return send(response, 404, { message: 'Not Found' });
      return send(response, 200, repositoryBody(repository));
    }

    // Everything below authenticates as the App with its JWT.
    const appEndpoint =
      path === '/app' ||
      path === '/app/installations' ||
      /^\/app\/installations\/\d+\/access_tokens$/.test(path) ||
      /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path);
    if (!appEndpoint) return send(response, 404, { message: 'Not Found' });
    if (!verifyJwt(authorization)) {
      return send(response, 401, { message: 'A JSON web token could not be decoded' });
    }

    if (method === 'GET' && path === '/app') {
      return send(response, 200, {
        id: secrets.appId,
        slug: secrets.slug,
        name: secrets.name,
        owner: {
          login: secrets.account,
          ...(state.appOwnerType ? { type: state.appOwnerType } : {}),
        },
        permissions: state.appPermissions,
        events: state.appEvents,
      });
    }

    if (method === 'GET' && path === '/app/installations') {
      const { slice, headers } = page(url, state.installations);
      return send(
        response,
        200,
        slice.map((installation) => ({
          id: installation.id,
          account: { login: installation.account },
          suspended_at: installation.suspended ? '2026-11-01T00:00:00Z' : null,
        })),
        headers,
      );
    }

    if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path))) {
      const fullName = `${match[1]}/${match[2]}`.toLowerCase();
      const repository = state.repositories.find(
        (candidate) => candidate.fullName.toLowerCase() === fullName,
      );
      const installation = state.installations.find(
        (candidate) => candidate.id === repository?.installationId,
      );
      if (!installation) return send(response, 404, { message: 'Not Found' });
      return send(response, 200, { id: installation.id, account: { login: installation.account } });
    }

    if (method === 'POST' && (match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
      const installationId = Number(match[1]);
      const installation = state.installations.find((candidate) => candidate.id === installationId);
      if (!installation || installation.mintFailure === 404) {
        return send(response, 404, { message: 'Not Found' });
      }
      if (installation.mintFailure === 'rate_limited') {
        return send(
          response,
          403,
          { message: 'API rate limit exceeded' },
          {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
          },
        );
      }
      if (installation.suspended || installation.mintFailure === 403) {
        return send(response, 403, { message: 'This installation has been suspended' });
      }
      const repositoryIds = fields.repository_ids;
      if (
        repositoryIds !== undefined &&
        (!Array.isArray(repositoryIds) ||
          !repositoryIds.every((id) =>
            state.repositories.some(
              (repository) => repository.id === id && repository.installationId === installationId,
            ),
          ))
      ) {
        return send(response, 422, {
          message:
            'There is at least one repository that does not exist or is not accessible to the parent installation.',
        });
      }
      const requested = (fields.permissions ?? state.appPermissions) as Record<string, unknown>;
      const rank = (level: unknown) => (level === 'write' ? 2 : level === 'read' ? 1 : 0);
      const granted: Record<string, string> = {};
      for (const [name, level] of Object.entries(requested)) {
        if (rank(level) === 0 || rank(level) > rank(state.appPermissions[name])) {
          return send(response, 422, { message: 'The permissions requested are not granted.' });
        }
        granted[name] = String(level);
      }
      const token: StandInInstallationToken = {
        token: `ghs_${randomBytes(16).toString('hex')}`,
        installationId,
        repositoryIds: (repositoryIds as number[] | undefined) ?? null,
        permissions: granted,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
      state.installationTokens.set(token.token, token);
      return send(response, 201, {
        token: token.token,
        expires_at: token.expiresAt,
        permissions: granted,
        repository_selection: token.repositoryIds === null ? 'all' : 'selected',
      });
    }

    return send(response, 404, { message: 'Not Found' });
  }

  function handleWeb(method: string, url: URL, body: unknown, response: ServerResponse) {
    if (method === 'GET' && url.pathname === '/login/oauth/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const challenge = url.searchParams.get('code_challenge');
      if (
        url.searchParams.get('client_id') !== secrets.clientId ||
        !redirectUri ||
        !challenge ||
        url.searchParams.get('code_challenge_method') !== 'S256'
      ) {
        return send(response, 400, { message: 'Bad authorize request' });
      }
      if (state.authorizeCode === null) {
        response.writeHead(200, { 'content-type': 'text/html' });
        return response.end('<p>Authorize Atlas stand-in</p>');
      }
      challenges.set(state.authorizeCode, challenge);
      const target = new URL(redirectUri);
      target.searchParams.set('code', state.authorizeCode);
      target.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: target.href });
      return response.end();
    }

    if (method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const fields = (body ?? {}) as Record<string, unknown>;
      if (fields.client_id !== secrets.clientId || fields.client_secret !== secrets.clientSecret) {
        return send(response, 200, { error: 'incorrect_client_credentials' });
      }
      const code = typeof fields.code === 'string' ? fields.code : '';
      if (!(code in state.users) || usedCodes.has(code)) {
        return send(response, 200, { error: 'bad_verification_code' });
      }
      // A code obtained through the authorize page is bound to its PKCE challenge.
      const challenge = challenges.get(code);
      const verifier = typeof fields.code_verifier === 'string' ? fields.code_verifier : '';
      if (
        challenge !== undefined &&
        createHash('sha256').update(verifier).digest('base64url') !== challenge
      ) {
        return send(response, 200, { error: 'bad_verification_code' });
      }
      usedCodes.add(code);
      const token = `ghu_${randomBytes(16).toString('hex')}`;
      state.userTokens.set(token, code);
      return send(response, 200, { access_token: token, token_type: 'bearer', scope: '' });
    }

    return send(response, 404, { message: 'Not Found' });
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', origin);
      const text = Buffer.concat(chunks).toString();
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const method = request.method ?? 'GET';
      const authorization = request.headers.authorization ?? null;
      const recorded = { method, path: url.pathname, body, authorization };
      state.requests.push(recorded);

      const failure = state.failWhen?.(recorded) ?? null;
      if (failure !== null) return send(response, failure, { message: 'Server Error' });
      if (state.failWith === 'hang') return;
      if (state.failWith === 500) return send(response, 500, { message: 'Server Error' });
      if (state.failWith === 403) {
        return send(
          response,
          403,
          { message: 'API rate limit exceeded' },
          {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
          },
        );
      }

      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        const path = url.pathname.slice(API_PREFIX.length);
        return handleApi(method, path, url, body, authorization, response);
      }
      return handleWeb(method, url, body, response);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  let closed: Promise<void> | undefined;
  return {
    apiUrl: `${origin}${API_PREFIX}`,
    webUrl: origin,
    secrets,
    state,
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
