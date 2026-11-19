import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ProjectCreateResponseSchema } from '@atlas/contracts';
import type { Worker } from '@atlas/contracts';
import { FolderGit2, Link2 } from 'lucide-react';
import { Dialog } from '../../components/ui/dialog';
import { request, errorMessage } from '../../lib/api';

export function CreateProjectDialog({
  workers,
  onClose,
  onCreated,
}: {
  workers: Worker[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const available = workers.filter(
    (worker) =>
      worker.kind === 'atlas' &&
      worker.availability === 'online' &&
      worker.capabilities.includes('repository.init'),
  );
  const [mode, setMode] = useState<'existing' | 'local'>('existing');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [path, setPath] = useState('');
  const [workerId, setWorkerId] = useState('');
  const worker =
    available.find((item) => item.id === workerId) ??
    (available.length === 1 ? available[0] : undefined);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      request('/projects', ProjectCreateResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          name,
          repository:
            mode === 'existing'
              ? { mode, gitUrl }
              : { mode, workerId: worker?.id, relativePath: path },
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
  return (
    <Dialog
      title="Create project"
      description="Give your next idea a place to take shape."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!mutation.isPending) mutation.mutate();
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
            <div className="mode-options">
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
                <label>
                  Atlas worker
                  <select
                    aria-label="Atlas worker"
                    required
                    value={worker?.id ?? ''}
                    onChange={(e) => setWorkerId(e.target.value)}
                  >
                    <option value="">Select an online worker</option>
                    {available.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {!available.length && (
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
                    onChange={(e) => setPath(e.target.value)}
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
            {errorMessage(mutation.error)} If the connection was lost, check the project list before
            trying again.
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              mutation.isPending || !name.trim() || (mode === 'local' && (!worker || !path.trim()))
            }
          >
            {mutation.isPending ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
