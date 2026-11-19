import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TaskResponseSchema, TaskStatusSchema, TASK_STATUS_LABELS } from '@atlas/contracts';
import type { Task, TaskCreate, TaskChanges, Worker, Version, TaskStatus } from '@atlas/contracts';
import { Dialog } from '../../components/ui/dialog';
import { request, errorMessage } from '../../lib/api';
import { TaskFields } from './TaskFields';

export function TaskDetails({
  task,
  workers,
  versions,
  onClose,
  onMove,
  moving,
}: {
  task: Task;
  workers: Worker[];
  versions: Version[];
  onClose: () => void;
  onMove: (task: Task, status: TaskStatus, before: string | null) => void;
  moving: boolean;
}) {
  const [draft, setDraft] = useState<TaskCreate>(() => ({
    title: task.title,
    description: task.description,
    type: task.type,
    priority: task.priority,
    assigneeId: task.assigneeId,
  }));
  const [versionId, setVersionId] = useState(task.versionId);
  const [saved, setSaved] = useState(false);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => {
      const changes: TaskChanges =
        task.status === 'backlog' ? { ...draft, versionId } : { description: draft.description };
      return request(`/tasks/${task.id}`, TaskResponseSchema, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: task.revision, changes }),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['tasks', task.projectId] });
      setSaved(true);
      if (versionId !== task.versionId) onClose();
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ['tasks', task.projectId] });
    },
  });
  return (
    <Dialog
      panel
      title="Task details"
      description={`${task.id.slice(0, 8).toUpperCase()} · ${TASK_STATUS_LABELS[task.status]}`}
      onClose={onClose}
    >
      <label className="status-field">
        Status
        <select
          aria-label="Status"
          value={task.status}
          disabled={moving || mutation.isPending}
          onChange={(e) => onMove(task, TaskStatusSchema.parse(e.target.value), null)}
        >
          {TaskStatusSchema.options.map((status) => (
            <option key={status} value={status}>
              {TASK_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <p className="field-note">
        {task.status === 'backlog'
          ? 'All fields are editable in Backlog.'
          : task.status === 'done'
            ? 'Done tasks are read-only. Move back to Backlog to make changes.'
            : 'Only the description can be edited here. Move to Backlog to change other fields.'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!mutation.isPending && task.status !== 'done') mutation.mutate();
        }}
      >
        <fieldset disabled={mutation.isPending || moving}>
          <TaskFields
            value={draft}
            onChange={(next) => {
              setDraft(next);
              setSaved(false);
            }}
            workers={workers}
            locked={task.status !== 'backlog'}
            descriptionLocked={task.status === 'done'}
            versions={versions}
            versionId={versionId}
            onVersionChange={setVersionId}
          />
        </fieldset>
        <p className="field-note">Assignment records responsibility. It does not start work.</p>
        {mutation.error && (
          <p role="alert" className="error">
            {errorMessage(mutation.error)} Your draft has been kept.
          </p>
        )}
        {saved && (
          <p role="status" className="success">
            Changes saved.
          </p>
        )}
        <div className="form-actions">
          <button
            className="button primary"
            disabled={task.status === 'done' || mutation.isPending || moving || !draft.title.trim()}
          >
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
