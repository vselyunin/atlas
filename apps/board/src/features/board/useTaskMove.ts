import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TaskResponseSchema } from '@atlas/contracts';
import type { Task, TaskStatus, TaskListResponse } from '@atlas/contracts';
import { request } from '../../lib/api';
import { taskKey } from '../../lib/queries';

export function useTaskMove(projectId: string, versionId: string) {
  const client = useQueryClient();
  const key = taskKey(projectId, versionId);
  return useMutation({
    mutationFn: ({
      task,
      status,
      before,
    }: {
      task: Task;
      status: TaskStatus;
      before: string | null;
    }) =>
      request(`/tasks/${task.id}/move`, TaskResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: task.revision, status, beforeTaskId: before }),
      }),
    onMutate: async ({ task, status, before }) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<TaskListResponse>(key);
      if (previous) {
        const remaining = previous.items.filter((item) => item.id !== task.id);
        const destination = remaining
          .filter((item) => item.status === status)
          .sort((a, b) => a.position - b.position);
        const index = before
          ? destination.findIndex((item) => item.id === before)
          : destination.length;
        destination.splice(index < 0 ? destination.length : index, 0, { ...task, status });
        client.setQueryData(key, {
          items: [
            ...remaining.filter((item) => item.status !== status),
            ...destination.map((item, position) => ({ ...item, position })),
          ],
        });
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}
