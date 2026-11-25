import { useId } from 'react';
import { errorMessage } from '../../lib/api';
import { isWebUrl } from '../../lib/auth';
import { useGithubConnection, useGithubRepositories } from '../../lib/queries';

// Chooses one of the repositories the GitHub App can reach. `value` is the repository ID.
export function RepositoryPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (repositoryId: number | null) => void;
}) {
  const id = useId();
  const repositories = useGithubRepositories();
  const connection = useGithubConnection();
  const installUrl = connection.data?.connection.installUrl;
  if (repositories.isPending) return <p role="status">Loading repositories…</p>;
  if (repositories.error) {
    return (
      <p role="alert" className="error">
        {errorMessage(repositories.error)}
      </p>
    );
  }
  if (!repositories.data.items.length) {
    return (
      <p role="status" className="field-note">
        The GitHub App reaches no repositories yet.{' '}
        {installUrl && isWebUrl(installUrl) && (
          <a href={installUrl} target="_blank" rel="noreferrer">
            Choose repositories on GitHub
          </a>
        )}
      </p>
    );
  }
  return (
    <>
      <label htmlFor={id}>Repository</label>
      <select
        id={id}
        value={value === null ? '' : String(value)}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">Choose a repository</option>
        {repositories.data.items.map((repository) => (
          <option key={repository.id} value={repository.id}>
            {repository.fullName}
          </option>
        ))}
      </select>
    </>
  );
}
