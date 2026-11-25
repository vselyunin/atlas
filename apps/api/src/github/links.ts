import type { GithubLink } from '@atlas/contracts';
import { eq } from 'drizzle-orm';
import type { ApiContext, DbTransaction } from '../db/client.js';
import { githubLinks } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { getProject } from '../projects/service.js';
import type { AppFile } from './app-file.js';
import { GitHubError } from './client.js';
import type { GitHubClient } from './client.js';

export type StoredLink = { repositoryId: number; fullName: string; defaultBranch: string };

// What was stored at link time, with no call to GitHub. Usable with sign-in off, where there is
// no LinkService, so that a clone dispatched earlier can still be sent again.
export function storedLink(
  db: ApiContext['db'] | DbTransaction,
  projectId: string,
): StoredLink | null {
  const row = db.select().from(githubLinks).where(eq(githubLinks.projectId, projectId)).get();
  if (!row) return null;
  return {
    repositoryId: row.repositoryId,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
  };
}

// The repository a project is linked to. Only the repository ID, its name and default branch at
// link time are stored; GitHub is asked each time whether the App still covers the repository.
export class LinkService {
  constructor(
    private readonly context: ApiContext,
    private readonly appFile: AppFile,
    private readonly github: GitHubClient,
  ) {}

  // Never throws for GitHub: when GitHub cannot be reached the link shows as not accessible.
  async get(projectId: string): Promise<GithubLink | null> {
    getProject(this.context.db, projectId);
    const row = this.row(projectId);
    if (!row) return null;
    let accessible = false;
    try {
      const secrets = this.appFile.read();
      if (secrets) {
        accessible = (await this.github.getRepositoryById(secrets, row.repositoryId)) !== null;
      }
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
    }
    return toLink(row, accessible);
  }

  async create(
    projectId: string,
    repositoryId: number,
    userId: string | null,
  ): Promise<GithubLink> {
    const project = getProject(this.context.db, projectId);
    if (project.repository.mode !== 'local' || project.state !== 'ready') {
      throw new ApiError(
        409,
        'project_not_linkable',
        'Only a ready project created on a Worker can be linked',
      );
    }
    if (this.row(projectId)) {
      throw new ApiError(409, 'already_linked', 'Project is already linked to a repository');
    }
    const secrets = this.appFile.read();
    if (!secrets) throw new ApiError(409, 'setup_required', 'Atlas is not set up yet');
    let found: Awaited<ReturnType<GitHubClient['getRepositoryById']>>;
    try {
      found = await this.github.getRepositoryById(secrets, repositoryId);
    } catch (error) {
      // GitHubError messages name the operation and outcome only.
      if (error instanceof GitHubError)
        throw new ApiError(502, 'github_unavailable', error.message);
      throw error;
    }
    if (!found) {
      throw new ApiError(
        403,
        'repository_not_accessible',
        'The GitHub App cannot access this repository',
      );
    }
    // No await since the check above: a second link cannot slip in between.
    if (this.row(projectId)) {
      throw new ApiError(409, 'already_linked', 'Project is already linked to a repository');
    }
    const row = {
      projectId,
      repositoryId: found.repository.id,
      fullName: found.repository.fullName,
      defaultBranch: found.repository.defaultBranch,
      createdBy: userId,
      createdAt: this.context.now(),
    };
    this.context.db.insert(githubLinks).values(row).run();
    return toLink(row, true);
  }

  remove(projectId: string): void {
    getProject(this.context.db, projectId);
    const removed = this.context.db
      .delete(githubLinks)
      .where(eq(githubLinks.projectId, projectId))
      .run();
    if (removed.changes === 0) {
      throw new ApiError(404, 'link_not_found', 'Project is not linked to a repository');
    }
  }

  // What was stored at link time, with no call to GitHub.
  stored(projectId: string): StoredLink | null {
    return storedLink(this.context.db, projectId);
  }

  private row(projectId: string) {
    return (
      this.context.db
        .select()
        .from(githubLinks)
        .where(eq(githubLinks.projectId, projectId))
        .get() ?? null
    );
  }
}

function toLink(
  row: {
    projectId: string;
    repositoryId: number;
    fullName: string;
    defaultBranch: string;
    createdAt: string;
  },
  accessible: boolean,
): GithubLink {
  return {
    projectId: row.projectId,
    repositoryId: row.repositoryId,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    accessible,
    createdAt: row.createdAt,
  };
}
