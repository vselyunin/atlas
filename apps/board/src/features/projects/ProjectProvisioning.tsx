import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { OperationResponseSchema } from '@atlas/contracts';
import type { Project } from '@atlas/contracts';
import { FolderGit2 } from 'lucide-react';
import { request, errorMessage } from '../../lib/api';

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
            : 'Preparing your repository'}
      </h2>
      <p>
        {operation?.error?.message ??
          (operation?.connectionLost
            ? 'Waiting for the worker to reconnect. Your request is preserved.'
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
