import { writeFileSync } from 'node:fs';
import type { LightMyRequestResponse } from 'fastify';
import type { ApiOptions } from '../../src/app.js';
import { buildAuthApp, signIn } from './auth-app.js';
import type { GithubStandIn } from './github-stand-in.js';

// The API with sign-in on and setup done against a GitHub stand-in, and an owner signed in.

export const OWNER = { id: 101, login: 'the-owner' };
export const REPOSITORY = {
  id: 501,
  fullName: 'octo-org/atlas',
  private: true,
  defaultBranch: 'main',
  installationId: 1,
};

export type CloneApi = Awaited<ReturnType<typeof buildAuthApp>> & {
  owner: string;
  // Posts a project create request as the owner.
  create(repository: Record<string, unknown>, name?: string): Promise<LightMyRequestResponse>;
  // Lines written to the API log.
  logLines: string[];
};

// Resets the stand-in to one installation and one repository.
export function resetStandIn(github: GithubStandIn) {
  Object.assign(github.state, {
    users: {},
    authorizeCode: null,
    failWith: null,
    failWhen: undefined,
    requests: [],
    installations: [{ id: 1, account: github.secrets.account }],
    repositories: [{ ...REPOSITORY }],
  });
  github.state.installationTokens.clear();
}

export async function startCloneApi(
  github: GithubStandIn,
  overrides: Partial<ApiOptions> = {},
): Promise<CloneApi> {
  const logLines: string[] = [];
  const api = await buildAuthApp(
    { logStream: { write: (line: string) => logLines.push(line) }, ...overrides },
    {
      github,
      prepare: ({ appFile }) =>
        writeFileSync(appFile, JSON.stringify(github.secrets), { mode: 0o600 }),
    },
  );
  try {
    const traded = await api.app.inject({
      method: 'POST',
      url: '/api/v1/setup/owner-code',
      payload: { code: api.ownerCodes[0] ?? '' },
    });
    const mark = traded.cookies.find((entry) => entry.name === 'atlas_setup_mark')?.value ?? '';
    const owner = await signIn(api.app, OWNER, { atlas_setup_mark: mark });
    return {
      ...api,
      owner,
      logLines,
      create: (repository, name = 'Cloned') =>
        api.app.inject({
          method: 'POST',
          url: '/api/v1/projects',
          headers: { cookie: owner },
          payload: { name, repository },
        }),
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}

export function errorCode(response: { json(): unknown }) {
  return (response.json() as { error: { code: string } }).error.code;
}
