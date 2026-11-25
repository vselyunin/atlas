import { API_BASE_PATH } from '@atlas/contracts';
import type { GithubConnectionResponse } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../http/errors.js';
import type { AppFile } from './app-file.js';
import { GitHubError } from './client.js';
import type { GitHubClient } from './client.js';
import { appInstallUrl, appSettingsUrl } from './urls.js';

export function registerGithubRoutes(
  app: FastifyInstance,
  appFile: AppFile,
  github: GitHubClient,
  webUrl: string,
) {
  // The App as GitHub reports it now, with links to manage and install it.
  app.get(`${API_BASE_PATH}/github/connection`, async (): Promise<GithubConnectionResponse> => {
    const secrets = appFile.read();
    if (!secrets) throw new ApiError(409, 'setup_required', 'Atlas is not set up yet');
    let current: Awaited<ReturnType<GitHubClient['readApp']>>;
    try {
      current = await github.readApp(secrets);
    } catch (error) {
      // GitHubError messages name the operation and outcome only.
      if (error instanceof GitHubError)
        throw new ApiError(502, 'github_unavailable', error.message);
      throw error;
    }
    return {
      connection: {
        name: current.name,
        slug: current.slug,
        account: current.account,
        manageUrl: appSettingsUrl(webUrl, current.slug, {
          account: current.account,
          type: current.accountType,
        }),
        installUrl: appInstallUrl(webUrl, current.slug),
      },
    };
  });
}
