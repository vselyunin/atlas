import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GithubLinkResponseSchema } from '@atlas/contracts';
import type { Project } from '@atlas/contracts';
import { ApiError, NoContent, errorMessage, request } from '../../lib/api';
import { isWebUrl } from '../../lib/auth';
import { githubLinkKey, useGithubConnection, useGithubLink } from '../../lib/queries';
import { RepositoryPicker } from './RepositoryPicker';

const notLinkable =
  'Only a ready project that was created from a folder on a worker can be linked to a repository.';

function refusal(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'project_not_found':
        return 'This project no longer exists.';
      case 'project_not_linkable':
        return notLinkable;
      case 'already_linked':
        return 'This project is already linked to a repository.';
      case 'repository_not_accessible':
        return 'The GitHub App cannot reach that repository. Choose repositories for Atlas on GitHub, then try again.';
      case 'link_not_found':
        return 'This project has no repository link to remove.';
      case 'github_unavailable':
        return 'Atlas could not reach GitHub. Try again in a moment.';
    }
  }
  return errorMessage(error);
}

// The repository linked to the selected project, with controls to link and unlink it.
export function GithubLink({ project }: { project: Project | undefined }) {
  const projectId = project?.id ?? '';
  const client = useQueryClient();
  const link = useGithubLink(projectId);
  const connection = useGithubConnection();
  const [repositoryId, setRepositoryId] = useState<number | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: githubLinkKey(projectId) });
  const create = useMutation({
    mutationFn: (id: number) =>
      request(`/projects/${projectId}/github-link`, GithubLinkResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ repositoryId: id }),
      }),
    onSuccess: () => setRepositoryId(null),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () =>
      request(`/projects/${projectId}/github-link`, NoContent, { method: 'DELETE', body: '{}' }),
    onSettled: refresh,
  });
  const installUrl = connection.data?.connection.installUrl;
  const busy = create.isPending || remove.isPending;
  // A new attempt starts clean, so an old refusal from one action is not shown for the other.
  const attempt = (run: () => void) => {
    create.reset();
    remove.reset();
    run();
  };

  let body;
  if (!project) {
    body = <p className="field-note">Select a project to link it to a GitHub repository.</p>;
  } else if (link.isPending) {
    body = <p role="status">Loading the link…</p>;
  } else if (link.error) {
    body = (
      <p role="alert" className="error">
        {refusal(link.error)}
      </p>
    );
  } else if (link.data.link) {
    const current = link.data.link;
    body = (
      <>
        <p>
          <strong>{current.fullName}</strong>
          <span className="muted"> default branch {current.defaultBranch}</span>
        </p>
        {!current.accessible && (
          <p role="alert" className="error">
            The GitHub App can no longer reach this repository. Choose repositories for Atlas on
            GitHub to restore access, or unlink it.
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => attempt(() => remove.mutate())}
          >
            {remove.isPending ? 'Unlinking…' : 'Unlink'}
          </button>
        </div>
      </>
    );
  } else if (project.repository.mode !== 'local' || project.state !== 'ready') {
    body = <p className="field-note">{notLinkable}</p>;
  } else {
    body = (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (repositoryId !== null && !busy) attempt(() => create.mutate(repositoryId));
        }}
      >
        <RepositoryPicker value={repositoryId} onChange={setRepositoryId} />
        <div className="form-actions">
          <button className="button primary" disabled={repositoryId === null || busy}>
            {create.isPending ? 'Linking…' : 'Link'}
          </button>
        </div>
      </form>
    );
  }
  return (
    <section aria-labelledby="settings-github-link">
      <h3 id="settings-github-link">
        {project ? `Repository for ${project.name}` : 'Project repository'}
      </h3>
      {body}
      {(create.error || remove.error) && (
        <p role="alert" className="error">
          {refusal(create.error ?? remove.error)}
        </p>
      )}
      {project && installUrl && isWebUrl(installUrl) && (
        <p className="settings-links">
          <a href={installUrl} target="_blank" rel="noreferrer">
            Change which repositories Atlas can reach
          </a>
        </p>
      )}
    </section>
  );
}
