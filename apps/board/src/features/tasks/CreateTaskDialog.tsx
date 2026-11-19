import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TaskResponseSchema } from '@atlas/contracts';
import type { TaskCreate, Worker } from '@atlas/contracts';
import { Dialog } from '../../components/ui/dialog';
import { request, errorMessage } from '../../lib/api';
import { taskKey } from '../../lib/queries';
import { TaskFields } from './TaskFields';

export function CreateTaskDialog({
  projectId,
  versionId,
  workers,
  onClose,
}: {
  projectId: string;
  versionId: string;
  workers: Worker[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TaskCreate>({
    title: '',
    description: '',
    type: 'task',
    priority: 'medium',
    assigneeId: null,
  });
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      request(`/projects/${projectId}/versions/${versionId}/tasks`, TaskResponseSchema, {
        method: 'POST',
        body: JSON.stringify(draft),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: taskKey(projectId, versionId) });
      onClose();
    },
  });
  return (
    <Dialog title="New task" description="Every task starts in Backlog." onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!mutation.isPending) mutation.mutate();
        }}
      >
        <fieldset disabled={mutation.isPending}>
          <TaskFields value={draft} onChange={setDraft} workers={workers} />
        </fieldset>
        {mutation.error && (
          <p role="alert" className="error">
            {errorMessage(mutation.error)}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={mutation.isPending || !draft.title.trim()}>
            {mutation.isPending ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
