import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { OperationResponseSchema } from '@atlas/contracts';
import type { Project } from '@atlas/contracts';
import { FolderGit2 } from 'lucide-react';
import { request, errorMessage } from '../../lib/api';
import { useAuthState } from '../../lib/auth';
import { useGithubLink } from '../../lib/queries';

export function ProjectProvisioning({ project }: { project: Project }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['operation', project.operationId],
    queryFn: ({ signal }) =>
      request(`/operations/${project.operationId}`, OperationResponseSchema, { signal }),
    enabled: !!project.operationId,
    refetchInterval: (current) =>
      ['succeeded', 'failed', 'needs_attention'].includes(current.state.data?.operation.state ?? '')
        ? false
        : 1_000,
  });
  const operation = query.data?.operation;
  // Nothing on the project says it is a clone. Its GitHub link does. With sign-in off there are no
  // links, so none is requested (an empty ID keeps the query off).
  const auth = useAuthState().data;
  const pending = project.state === 'pending' && project.repository.mode === 'local';
  const link = useGithubLink(auth?.auth === 'github' && auth.user && pending ? project.id : '');
  const cloning = pending ? link.data?.link?.fullName : undefined;
  useEffect(() => {
    if (operation?.state === 'succeeded') {
      void client.invalidateQueries({ queryKey: ['projects'] });
      void client.invalidateQueries({ queryKey: ['versions', project.id] });
    }
  }, [operation?.state, client, project.id]);
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <FolderGit2 size={28} />
      </div>
      <h2>
        {project.state === 'failed'
          ? 'Repository creation failed'
          : project.state === 'needs_attention'
            ? 'Repository needs attention'
            : cloning
              ? 'Cloning your repository'
              : 'Preparing your repository'}
      </h2>
      <p>
        {operation?.error?.message ??
          (operation?.connectionLost
            ? 'Waiting for the worker to reconnect. Your request is preserved.'
            : cloning
              ? `Your worker is cloning ${cloning} from GitHub.`
              : 'Your worker is initializing the local Git repository.')}
      </p>
      {query.error && (
        <p className="error" role="alert">
          {errorMessage(query.error)}
        </p>
      )}
    </div>
  );
}
