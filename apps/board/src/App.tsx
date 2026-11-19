import { useState } from 'react';
import { Plus, Layers3, FolderGit2, LayoutGrid, ChevronRight, CircleHelp } from 'lucide-react';
import type { Task, TaskStatus } from '@atlas/contracts';
import { useProjects, useVersions, useTasks, useWorkers } from './lib/queries';
import { errorMessage } from './lib/api';
import { BoardDnd } from './features/board/BoardDnd';
import { useTaskMove } from './features/board/useTaskMove';
import { CreateProjectDialog } from './features/projects/CreateProjectDialog';
import { CreateVersionDialog } from './features/projects/CreateVersionDialog';
import { ProjectProvisioning } from './features/projects/ProjectProvisioning';
import { CreateTaskDialog } from './features/tasks/CreateTaskDialog';
import { TaskDetails } from './features/tasks/TaskDetails';

export function App() {
  const [projectId, setProjectId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [dialog, setDialog] = useState<'project' | 'version' | 'task' | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const projects = useProjects();
  const workers = useWorkers();
  const project =
    projects.data?.items.find((item) => item.id === projectId) ?? projects.data?.items[0];
  const ready = project?.state === 'ready';
  const versions = useVersions(project?.id ?? '', ready);
  const version =
    versions.data?.items.find((item) => item.id === versionId) ?? versions.data?.items[0];
  const tasks = useTasks(project?.id ?? '', version?.id ?? '', ready);
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
      <header className="app-header">
        <a className="brand" href="/" aria-label="Atlas home">
          <span className="brand-mark">
            <Layers3 size={22} />
          </span>
          atlas
          <span className="brand-divider" />
        </a>
        <span className="workspace-label">Personal workspace</span>
        <div className="header-right">
          <span className="local-badge">
            <span />
            Local
          </span>
          <span className="user-avatar" title="Vladi">
            V
          </span>
        </div>
      </header>
      <div className="workspace-toolbar">
        <div className="selectors">
          <FolderGit2 size={17} className="muted" />
          <label className="sr-only" htmlFor="project-select">
            Project
          </label>
          <select
            id="project-select"
            className="toolbar-select"
            value={project?.id ?? ''}
            onChange={(e) => selectProject(e.target.value)}
          >
            <option value="" disabled>
              Select project
            </option>
            {projects.data?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            aria-label="Create project"
            onClick={() => setDialog('project')}
          >
            <Plus size={16} />
          </button>
          <ChevronRight size={15} className="muted" />
          <label className="sr-only" htmlFor="version-select">
            Version
          </label>
          <select
            id="version-select"
            className="toolbar-select version-select"
            value={version?.id ?? ''}
            disabled={!ready}
            onChange={(e) => {
              setVersionId(e.target.value);
              setSelectedId(null);
            }}
          >
            <option value="" disabled>
              Version
            </option>
            {versions.data?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            aria-label="Add version"
            disabled={!ready}
            onClick={() => setDialog('version')}
          >
            <Plus size={16} />
          </button>
        </div>
        <span
          className="worker-status"
          title={workers.error ? errorMessage(workers.error) : 'Registered workers from the API'}
        >
          <span className={online ? 'online-dot' : 'offline-dot'} />
          {workers.error
            ? 'Workers unavailable'
            : `${online} worker${online === 1 ? '' : 's'} online`}
        </span>
      </div>
      <main className="main-content">
        <div className="page-heading">
          <div>
            <div className="eyebrow">BUILD SOMETHING GOOD</div>
            <h1>
              Project board<span className="heading-dot">.</span>
            </h1>
            <p>A little structure. A lot of possibility.</p>
          </div>
          <button
            className="button primary"
            disabled={!ready || !version || move.isPending}
            onClick={() => setDialog('task')}
          >
            <Plus size={17} />
            New task
          </button>
        </div>
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
            <div className="board-meta">
              <span>
                <LayoutGrid size={15} />
                Board
              </span>
              <span>
                {items.length} task{items.length === 1 ? '' : 's'}
                <i />
                {version?.name ?? 'Loading version…'}
              </span>
            </div>
            {tasks.isPending && version ? (
              <p className="loading-message" role="status">
                Loading tasks…
              </p>
            ) : null}
            <BoardDnd
              tasks={items}
              workers={workerItems}
              onOpen={(task) => setSelectedId(task.id)}
              onCreate={() => setDialog('task')}
              onMove={onMove}
              disabled={move.isPending || !version || tasks.isPending}
            />
            <div className="board-footnote">
              <CircleHelp size={14} />
              Drag cards to move work forward. New tasks start in Backlog.
            </div>
          </>
        )}
      </main>
      <footer className="app-footer">
        <span>ATLAS</span>
        <span>Your work, at your pace.</span>
      </footer>
      {dialog === 'project' && (
        <CreateProjectDialog workers={workerItems} onClose={close} onCreated={selectProject} />
      )}
      {dialog === 'version' && project && (
        <CreateVersionDialog projectId={project.id} onClose={close} onCreated={setVersionId} />
      )}
      {dialog === 'task' && project && version && (
        <CreateTaskDialog
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
