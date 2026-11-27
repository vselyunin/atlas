import {
  API_BASE_PATH,
  GithubLinkCreateSchema,
  GithubLinkResponseSchema,
  GithubRepositoryListResponseSchema,
  IdSchema,
} from '@atlas/contracts';
import type { GithubConnectionResponse } from '@atlas/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, parseInput } from '../http/errors.js';
import type { AppFile } from './app-file.js';
import { GitHubError } from './client.js';
import type { GitHubClient } from './client.js';
import type { LinkService } from './links.js';
import { appInstallUrl, appSettingsUrl } from './urls.js';

const ProjectParamsSchema = z.strictObject({ projectId: IdSchema });

// With sign-in off there is no GitHub App: every repository and link route says so.
export function registerGithubUnavailableRoutes(app: FastifyInstance) {
  const unavailable = () => {
    throw new ApiError(409, 'github_unavailable', 'GitHub is not available while sign-in is off');
  };
  const link = `${API_BASE_PATH}/projects/:projectId/github-link`;
  app.get(`${API_BASE_PATH}/github/repositories`, unavailable);
  app.get(link, unavailable);
  app.post(link, unavailable);
  app.delete(link, unavailable);
}

export function registerGithubRoutes(
  app: FastifyInstance,
  appFile: AppFile,
  github: GitHubClient,
  webUrl: string,
  links: LinkService,
) {
  // The repositories the App can reach through its installations.
  app.get(`${API_BASE_PATH}/github/repositories`, async () => {
    const secrets = appFile.read();
    if (!secrets) throw new ApiError(409, 'setup_required', 'Atlas is not set up yet');
    try {
      return GithubRepositoryListResponseSchema.parse({
        items: await github.listRepositories(secrets),
      });
    } catch (error) {
      if (error instanceof GitHubError)
        throw new ApiError(502, 'github_unavailable', error.message);
      throw error;
    }
  });
  const linkPath = `${API_BASE_PATH}/projects/:projectId/github-link`;
  app.get(linkPath, async (request) => {
    const { projectId } = parseInput(ProjectParamsSchema, request.params);
    return GithubLinkResponseSchema.parse({ link: await links.get(projectId) });
  });
  app.post(linkPath, async (request, reply) => {
    const { projectId } = parseInput(ProjectParamsSchema, request.params);
    const { repositoryId } = parseInput(GithubLinkCreateSchema, request.body);
    const link = await links.create(projectId, repositoryId, request.user?.id ?? null);
    return reply.code(201).send(GithubLinkResponseSchema.parse({ link }));
  });
  app.delete(linkPath, (request, reply) => {
    const { projectId } = parseInput(ProjectParamsSchema, request.params);
    links.remove(projectId);
    return reply.code(204).send();
  });

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
