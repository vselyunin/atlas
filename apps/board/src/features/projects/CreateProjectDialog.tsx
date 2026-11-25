import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ProjectCreateResponseSchema, REPOSITORY_CLONE_CAPABILITY } from '@atlas/contracts';
import type { Worker } from '@atlas/contracts';
import { FolderGit2, Github, Link2 } from 'lucide-react';
import { Dialog } from '../../components/ui/dialog';
import { ApiError, request, errorMessage } from '../../lib/api';
import { useAuthState } from '../../lib/auth';
import { useGithubRepositories } from '../../lib/queries';
import { RepositoryPicker } from './RepositoryPicker';

type Mode = 'existing' | 'local' | 'clone';

// Plain sentences for the refusals that only a clone can meet.
function cloneRefusal(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  switch (error.code) {
    case 'worker_unavailable':
      return 'That Worker cannot clone right now. Choose an online Worker that can clone, or start it and try again.';
    case 'repository_not_accessible':
      return 'The GitHub App cannot reach that repository. Choose repositories for Atlas on GitHub, then try again.';
    case 'github_unavailable':
      return 'Atlas could not reach GitHub. Try again in a moment.';
    case 'invalid_relative_path':
      return 'Choose a folder under the Worker workspace. It cannot start with a dot or contain "..".';
    case 'setup_required':
      return 'Atlas is not connected to GitHub yet. Finish setting up the GitHub App first.';
    default:
      return undefined;
  }
}

export function CreateProjectDialog({
  workers,
  onClose,
  onCreated,
}: {
  workers: Worker[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const auth = useAuthState().data;
  const signedIn = auth?.auth === 'github' && !!auth.user;
  const online = workers.filter(
    (worker) => worker.kind === 'atlas' && worker.availability === 'online',
  );
  const available = online.filter((worker) => worker.capabilities.includes('repository.init'));
  const cloners = online.filter((worker) =>
    worker.capabilities.includes(REPOSITORY_CLONE_CAPABILITY),
  );
  const [chosen, setMode] = useState<Mode>('existing');
  const mode = chosen === 'clone' && !signedIn ? 'existing' : chosen;
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [path, setPath] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [repositoryId, setRepositoryId] = useState<number | null>(null);
  const [pathEdited, setPathEdited] = useState(false);
  const candidates = mode === 'clone' ? cloners : available;
  const worker =
    candidates.find((item) => item.id === workerId) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (submitted: Mode) =>
      request('/projects', ProjectCreateResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          name,
          repository:
            submitted === 'existing'
              ? { mode: 'existing', gitUrl }
              : submitted === 'clone'
                ? {
                    mode: 'local',
                    workerId: worker?.id,
                    relativePath: path,
                    githubRepositoryId: repositoryId,
                  }
                : { mode: 'local', workerId: worker?.id, relativePath: path },
        }),
      }),
    onSuccess: async ({ project }) => {
      await client.invalidateQueries({ queryKey: ['projects'] });
      onCreated(project.id);
      onClose();
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const refusal = mutation.variables === 'clone' ? cloneRefusal(mutation.error) : undefined;
  const incomplete =
    mode === 'clone'
      ? repositoryId === null || !worker || !path.trim()
      : mode === 'local' && (!worker || !path.trim());
  return (
    <Dialog
      title="Create project"
      description="Give your next idea a place to take shape."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!mutation.isPending && !incomplete) mutation.mutate(mode);
        }}
      >
        <fieldset disabled={mutation.isPending}>
          <div className="form-fields">
            <label>
              Project name
              <input
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My next project"
              />
            </label>
            <div className={signedIn ? 'mode-options three' : 'mode-options'}>
              <button
                type="button"
                className={mode === 'existing' ? 'mode active' : 'mode'}
                onClick={() => setMode('existing')}
                aria-pressed={mode === 'existing'}
              >
                <Link2 size={20} />
                <strong>Existing repository</strong>
                <span>Connect a Git URL</span>
              </button>
              <button
                type="button"
                className={mode === 'local' ? 'mode active' : 'mode'}
                onClick={() => setMode('local')}
                aria-pressed={mode === 'local'}
              >
                <FolderGit2 size={20} />
                <strong>New local repository</strong>
                <span>Initialize a fresh folder</span>
              </button>
              {signedIn && (
                <button
                  type="button"
                  className={mode === 'clone' ? 'mode active' : 'mode'}
                  onClick={() => setMode('clone')}
                  aria-pressed={mode === 'clone'}
                >
                  <Github size={20} />
                  <strong>Clone from GitHub</strong>
                  <span>Copy a repository onto a Worker</span>
                </button>
              )}
            </div>
            {mode === 'existing' ? (
              <>
                <label>
                  Git URL
                  <input
                    required
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    placeholder="https://github.com/you/project.git"
                  />
                </label>
                <p className="field-note">
                  The URL is saved for reference. The repository is not cloned.
                </p>
              </>
            ) : (
              <>
                {mode === 'clone' && (
                  <CloneRepository
                    value={repositoryId}
                    onChange={(id, repositoryName) => {
                      setRepositoryId(id);
                      if (id !== null && repositoryName && !pathEdited) setPath(repositoryName);
                    }}
                  />
                )}
                {mode === 'clone' && !cloners.length ? (
                  <p role="status" className="error">
                    No connected Worker can clone repositories. Update and start your Worker, then
                    try again.
                  </p>
                ) : (
                  <label>
                    Atlas worker
                    <select
                      aria-label="Atlas worker"
                      required
                      value={worker?.id ?? ''}
                      onChange={(e) => setWorkerId(e.target.value)}
                    >
                      <option value="">Select an online worker</option>
                      {candidates.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {mode === 'local' && !available.length && (
                  <p role="status" className="error">
                    No repository worker is online. Start your Worker, or link an existing
                    repository.
                  </p>
                )}
                <label>
                  Folder path
                  <input
                    required
                    maxLength={1024}
                    value={path}
                    onChange={(e) => {
                      setPath(e.target.value);
                      setPathEdited(true);
                    }}
                    placeholder="my-project"
                  />
                </label>
                <p className="path-preview">
                  {worker?.workspaceRoot ?? 'Worker workspace'}/{path || 'my-project'}
                </p>
                <p className="field-note">
                  The folder must be new. Parent folders must already exist.
                </p>
              </>
            )}
          </div>
        </fieldset>
        {mutation.error && (
          <p role="alert" className="error">
            {refusal ??
              `${errorMessage(mutation.error)} If the connection was lost, check the project list before trying again.`}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending || !name.trim() || incomplete}
          >
            {mutation.isPending ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// The repository to clone. Reports the chosen ID with the repository's own name, for the folder.
function CloneRepository({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (repositoryId: number | null, repositoryName?: string) => void;
}) {
  const repositories = useGithubRepositories();
  return (
    <RepositoryPicker
      value={value}
      onChange={(id) => {
        const full = repositories.data?.items.find((item) => item.id === id)?.fullName;
        onChange(id, full?.split('/').pop());
      }}
    />
  );
}
