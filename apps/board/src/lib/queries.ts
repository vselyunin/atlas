import { useQuery } from '@tanstack/react-query';
import {
  ProjectListResponseSchema,
  VersionListResponseSchema,
  TaskListResponseSchema,
  WorkerListResponseSchema,
} from '@atlas/contracts';
import { request } from './api';

export const taskKey = (projectId: string, versionId: string) =>
  ['tasks', projectId, versionId] as const;
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => request('/projects', ProjectListResponseSchema, { signal }),
    refetchInterval: 5_000,
  });
}
export function useVersions(projectId: string, ready: boolean) {
  return useQuery({
    queryKey: ['versions', projectId],
    queryFn: ({ signal }) =>
      request(`/projects/${projectId}/versions`, VersionListResponseSchema, { signal }),
    enabled: !!projectId && ready,
  });
}
export function useTasks(projectId: string, versionId: string, ready: boolean) {
  return useQuery({
    queryKey: taskKey(projectId, versionId),
    queryFn: ({ signal }) =>
      request(`/projects/${projectId}/versions/${versionId}/tasks`, TaskListResponseSchema, {
        signal,
      }),
    enabled: !!projectId && !!versionId && ready,
  });
}
export function useWorkers() {
  return useQuery({
    queryKey: ['workers'],
    queryFn: ({ signal }) => request('/workers', WorkerListResponseSchema, { signal }),
    refetchInterval: 10_000,
  });
}
