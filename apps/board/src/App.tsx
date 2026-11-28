import { useMemo, useState } from 'react';
import { Plus, Layers3 } from 'lucide-react';
import type { Task, TaskStatus } from '@atlas/contracts';
import { useAuthState } from './lib/auth';
import { UserMenu } from './features/auth/UserMenu';
import { useProjects, useVersions, useTasks, useSessions, useWorkers } from './lib/queries';
import { errorMessage } from './lib/api';
import { BoardDnd } from './features/board/BoardDnd';
import { useTaskMove } from './features/board/useTaskMove';
import { CreateProjectDialog } from './features/projects/CreateProjectDialog';
import { CreateVersionDialog } from './features/projects/CreateVersionDialog';
import { ProjectProvisioning } from './features/projects/ProjectProvisioning';
import { CreateTaskDialog } from './features/tasks/CreateTaskDialog';
import { TaskDetails } from './features/tasks/TaskDetails';
import { BoardHeader } from './features/layout/BoardHeader';

export function App() {
  const [projectId, setProjectId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [dialog, setDialog] = useState<'project' | 'version' | 'task' | null>(null);
  const [creationStatus, setCreationStatus] = useState<'backlog' | 'todo'>('backlog');
  const createTask = (status: 'backlog' | 'todo' = 'backlog') => {
    setCreationStatus(status);
    setDialog('task');
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const authUser = useAuthState().data?.user ?? null;
  const projects = useProjects();
  const workers = useWorkers();
  const project =
    projects.data?.items.find((item) => item.id === projectId) ?? projects.data?.items[0];
  const ready = project?.state === 'ready';
  const versions = useVersions(project?.id ?? '', ready);
  const version =
    versions.data?.items.find((item) => item.id === versionId) ?? versions.data?.items[0];
  const tasks = useTasks(project?.id ?? '', version?.id ?? '', ready);
  const sessionList = useSessions(project?.id ?? '', version?.id ?? '', ready);
  const sessions = useMemo(
    () =>
      new Map((sessionList.data?.items ?? []).map(({ taskId, ...summary }) => [taskId, summary])),
    [sessionList.data],
  );
  const items = tasks.data?.items ?? [];
  const workerItems = workers.data?.items ?? [];
  const move = useTaskMove(project?.id ?? '', version?.id ?? '');
  const onMove = (task: Task, status: TaskStatus, before: string | null) => {
    if (!move.isPending) move.mutate({ task, status, before });
  };
  const selectedTask = items.find((task) => task.id === selectedId);
  const close = () => setDialog(null);
  const selectProject = (id: string) => {
    setProjectId(id);
    setVersionId('');
    setSelectedId(null);
    move.reset();
  };
  const online = workerItems.filter(
    (worker) => worker.kind === 'atlas' && worker.availability === 'online',
  ).length;
  const error = projects.error ?? versions.error ?? tasks.error;
  return (
    <>
      <BoardHeader
        projects={projects.data?.items ?? []}
        projectId={project?.id ?? ''}
        versions={versions.data?.items ?? []}
        versionId={version?.id ?? ''}
        ready={ready}
        taskCreationDisabled={!ready || !version || move.isPending || tasks.isPending}
        workerStatus={
          workers.error
            ? 'Workers unavailable'
            : `${online} worker${online === 1 ? '' : 's'} online`
        }
        onSelectProject={selectProject}
        onSelectVersion={(id) => {
          setVersionId(id);
          setSelectedId(null);
        }}
        onCreateProject={() => setDialog('project')}
        onCreateVersion={() => setDialog('version')}
        onCreateTask={() => createTask()}
        user={authUser ? <UserMenu user={authUser} project={project} /> : undefined}
      />
      <main className="main-content" aria-label="Project board">
        {error && (
          <div className="error-banner" role="alert">
            {errorMessage(error)}
            <button
              className="text-button"
              onClick={() => {
                void projects.refetch();
                void versions.refetch();
                void tasks.refetch();
              }}
            >
              Try again
            </button>
          </div>
        )}
        {move.error && (
          <div className="error-banner" role="alert">
            Move failed: {errorMessage(move.error)} Your board has been restored.
          </div>
        )}
        {!project ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Layers3 size={30} />
            </div>
            <h2>
              {projects.isPending
                ? 'Opening your workspace…'
                : 'A fresh start for your next project'}
            </h2>
            <p>
              {projects.isPending
                ? 'Connecting to your local API.'
                : 'Create a project, choose a version, and turn ideas into done.'}
            </p>
            {!projects.isPending && (
              <button className="button primary" onClick={() => setDialog('project')}>
                <Plus size={16} />
                Create your first project
              </button>
            )}
          </div>
        ) : !ready ? (
          <ProjectProvisioning project={project} />
        ) : (
          <>
            {tasks.isPending && version ? (
              <p className="loading-message" role="status">
                Loading tasks…
              </p>
            ) : null}
            <BoardDnd
              key={`${project.id}:${version?.id ?? ''}`}
              tasks={items}
              workers={workerItems}
              onOpen={(task) => setSelectedId(task.id)}
              onCreate={createTask}
              onMove={onMove}
              sessions={sessions}
              disabled={move.isPending || !version || tasks.isPending}
            />
          </>
        )}
      </main>
      {dialog === 'project' && (
        <CreateProjectDialog workers={workerItems} onClose={close} onCreated={selectProject} />
      )}
      {dialog === 'version' && project && (
        <CreateVersionDialog projectId={project.id} onClose={close} onCreated={setVersionId} />
      )}
      {dialog === 'task' && project && version && (
        <CreateTaskDialog
          status={creationStatus}
          projectId={project.id}
          versionId={version.id}
          workers={workerItems}
          onClose={close}
        />
      )}
      {selectedTask && (
        <TaskDetails
          key={selectedTask.id}
          task={selectedTask}
          workers={workerItems}
          versions={versions.data?.items ?? []}
          onClose={() => setSelectedId(null)}
          onMove={onMove}
          moving={move.isPending}
        />
      )}
    </>
  );
}
