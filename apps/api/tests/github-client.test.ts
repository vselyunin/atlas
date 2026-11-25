import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError } from '../src/github/client.js';
import { appJwt } from '../src/github/jwt.js';
import { startGithubStandIn } from './support/github-stand-in.js';
import type { GithubStandIn, StandInRepository } from './support/github-stand-in.js';

let github: GithubStandIn;
let client: GitHubClient;
beforeEach(async () => {
  github = await startGithubStandIn();
  client = new GitHubClient({ apiUrl: github.apiUrl, webUrl: github.webUrl });
});
afterEach(async () => {
  await github.close();
});

function repositories(count: number, installationId = 1, firstId = 1): StandInRepository[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    fullName: `octo-org/repo-${firstId + index}`,
    private: index % 2 === 0,
    defaultBranch: 'main',
    installationId,
  }));
}

async function failure(promise: Promise<unknown>): Promise<GitHubError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GitHubError);
  const githubError = error as GitHubError;
  for (const secret of [github.secrets.clientSecret, github.secrets.privateKey]) {
    expect(githubError.message).not.toContain(secret);
  }
  return githubError;
}

describe('appJwt', () => {
  it('is accepted by GitHub as the App', async () => {
    const response = await fetch(`${github.apiUrl}/app`, {
      headers: { authorization: `Bearer ${appJwt(github.secrets, new Date())}` },
    });
    expect(response.status).toBe(200);
  });

  it('is refused when signed by another key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const forged = { ...github.secrets, privateKey };
    const response = await fetch(`${github.apiUrl}/app`, {
      headers: { authorization: `Bearer ${appJwt(forged, new Date())}` },
    });
    expect(response.status).toBe(401);
    expect((await failure(client.describeApp(forged))).code).toBe('unauthorized');
  });

  it('is refused when expired or issued for another App', async () => {
    const old = appJwt(github.secrets, new Date(Date.now() - 20 * 60 * 1000));
    const other = appJwt({ ...github.secrets, appId: 1 }, new Date());
    for (const jwt of [old, other]) {
      const response = await fetch(`${github.apiUrl}/app`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(response.status).toBe(401);
    }
  });
});

describe('GitHubClient', () => {
  it('converts a manifest code into the App secrets', async () => {
    github.state.manifestCodes.push('manifest-code');
    await expect(client.convertManifest('manifest-code')).resolves.toEqual({
      ...github.secrets,
      ownerLogin: github.secrets.account,
    });
    const used = await failure(client.convertManifest('manifest-code'));
    expect(used.code).toBe('not_found');
    expect(used.message).not.toContain('manifest-code');
  });

  it('describes the App and reports whether it is public', async () => {
    await expect(client.describeApp(github.secrets)).resolves.toEqual({
      id: github.secrets.appId,
      slug: github.secrets.slug,
      name: github.secrets.name,
      account: github.secrets.account,
      public: false,
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      events: [],
    });
    github.state.appPublic = true;
    expect((await client.describeApp(github.secrets)).public).toBe(true);
    const lookup = github.state.requests.filter((request) => request.path.startsWith('/api/apps/'));
    expect(lookup.map((request) => request.authorization)).toEqual([null, null]);
  });

  it('signs a person in with PKCE and reads their account', async () => {
    github.state.users['user-code'] = {
      id: 77,
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://avatars.example/77',
    };
    github.state.authorizeCode = 'user-code';
    const redirectUri = 'http://localhost:5173/api/v1/auth/github/callback';
    const codeVerifier = 'v'.repeat(43);
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const url = new URL(
      client.authorizeUrl(github.secrets, { state: 'the-state', codeChallenge, redirectUri }),
    );
    expect(url.origin + url.pathname).toBe(`${github.webUrl}/login/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: github.secrets.clientId,
      redirect_uri: redirectUri,
      state: 'the-state',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const redirect = await fetch(url, { redirect: 'manual' });
    const back = new URL(redirect.headers.get('location') ?? '');
    expect(back.searchParams.get('state')).toBe('the-state');

    const wrong = await failure(
      client.exchangeUserCode(github.secrets, {
        code: 'user-code',
        codeVerifier: 'w'.repeat(43),
        redirectUri,
      }),
    );
    expect(wrong.code).toBe('unauthorized');

    const token = await client.exchangeUserCode(github.secrets, {
      code: back.searchParams.get('code') ?? '',
      codeVerifier,
      redirectUri,
    });
    await expect(client.getUser(token)).resolves.toEqual({
      id: 77,
      login: 'mona',
      name: 'Mona',
      avatarUrl: 'https://avatars.example/77',
    });

    await client.revokeUserToken(github.secrets, token);
    expect((await failure(client.getUser(token))).code).toBe('unauthorized');
    // A second revocation fails at GitHub and is swallowed.
    await expect(client.revokeUserToken(github.secrets, token)).resolves.toBeUndefined();
  });

  it('mints a token for one repository with only the requested right', async () => {
    github.state.repositories = repositories(3);
    const minted = await client.mintToken(github.secrets, {
      installationId: 1,
      repositoryId: 2,
      permissions: { contents: 'read' },
    });
    expect(minted.token).toMatch(/^ghs_/);
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.now());
    const mint = github.state.requests.find((request) => request.path.endsWith('/access_tokens'));
    expect(mint?.path).toBe('/api/app/installations/1/access_tokens');
    expect(mint?.body).toEqual({ repository_ids: [2], permissions: { contents: 'read' } });

    await expect(client.revokeToken(minted.token)).resolves.toBe(true);
    await expect(client.revokeToken(minted.token)).resolves.toBe(false);
  });

  it('lists every repository of every installation across pages', async () => {
    github.state.installations.push({ id: 2, account: 'octo-org' });
    github.state.repositories = [...repositories(250), ...repositories(5, 2, 1000)];
    const listed = await client.listRepositories(github.secrets);
    expect(listed).toHaveLength(255);
    expect(new Set(listed.map((repository) => repository.id)).size).toBe(255);
    expect(listed[0]).toEqual({
      id: 1,
      fullName: 'octo-org/repo-1',
      private: true,
      defaultBranch: 'main',
    });
    const pages = github.state.requests.filter(
      (request) => request.path === '/api/installation/repositories',
    );
    expect(pages).toHaveLength(4);
    const mints = github.state.requests.filter((request) =>
      request.path.endsWith('/access_tokens'),
    );
    expect(mints.map((request) => request.body)).toEqual([
      { permissions: { metadata: 'read' } },
      { permissions: { metadata: 'read' } },
    ]);
    // The listing tokens are revoked again.
    expect(github.state.installationTokens.size).toBe(0);
  });

  it('finds the installation that covers a repository', async () => {
    github.state.installations.push({ id: 2, account: 'octo-org' });
    github.state.repositories = [...repositories(2), ...repositories(2, 2, 50)];
    await expect(client.findInstallation(github.secrets, 'octo-org/repo-51')).resolves.toEqual({
      installationId: 2,
      repository: { id: 51, fullName: 'octo-org/repo-51', private: false, defaultBranch: 'main' },
    });
    await expect(client.findInstallation(github.secrets, 'octo-org/missing')).resolves.toBeNull();
    await expect(client.getRepositoryById(github.secrets, 50)).resolves.toEqual({
      installationId: 2,
      repository: { id: 50, fullName: 'octo-org/repo-50', private: true, defaultBranch: 'main' },
    });
    await expect(client.getRepositoryById(github.secrets, 999)).resolves.toBeNull();
    expect(github.state.installationTokens.size).toBe(0);
  });

  it('reports a server error as failed', async () => {
    github.state.failWith = 500;
    const error = await failure(client.describeApp(github.secrets));
    expect(error).toMatchObject({ code: 'failed', status: 500 });
  });

  it('reports an exhausted rate limit as rate_limited', async () => {
    github.state.failWith = 403;
    const error = await failure(client.listRepositories(github.secrets));
    expect(error).toMatchObject({ code: 'rate_limited', status: 403 });
  });

  it('gives up on a GitHub that does not answer', async () => {
    github.state.failWith = 'hang';
    const quick = new GitHubClient({
      apiUrl: github.apiUrl,
      webUrl: github.webUrl,
      timeoutMs: 200,
    });
    const started = Date.now();
    const error = await failure(quick.describeApp(github.secrets));
    expect(error).toMatchObject({ code: 'timeout', status: null });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports a GitHub that cannot be reached as unreachable', async () => {
    await github.close();
    const error = await failure(client.describeApp(github.secrets));
    expect(error).toMatchObject({ code: 'unreachable', status: null });
  });
});
