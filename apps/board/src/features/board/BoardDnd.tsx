import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { CollisionDetection, DragMoveEvent, DragEndEvent } from '@dnd-kit/core';
import { Plus, UserRound, Bot } from 'lucide-react';
import { TaskStatusSchema, TASK_STATUS_LABELS } from '@atlas/contracts';
import type { Task, TaskStatus, Worker } from '@atlas/contracts';
import { label } from '../tasks/TaskFields';
import { isSamePosition, orderedTasks, targetAtPointer } from './dropTarget';
import type { DropTarget } from './dropTarget';

function TaskContents({ task, workers }: { task: Task; workers: Worker[] }) {
  const worker = workers.find((item) => item.id === task.assigneeId);
  return (
    <>
      <span className="task-title">{task.title}</span>
      {task.description && <span className="card-description">{task.description}</span>}
      <span className="card-footer">
        <span
          className="assignee"
          title={worker?.availability === 'offline' ? 'Worker is offline' : worker?.name}
        >
          <span className={`avatar ${worker?.kind === 'human' ? 'human' : ''}`}>
            {worker?.kind === 'atlas' ? <Bot size={12} /> : <UserRound size={12} />}
          </span>
          <span>{worker?.name ?? 'Unassigned'}</span>
          {worker?.availability === 'offline' && <span className="offline-label">Offline</span>}
        </span>
        <span className="task-metadata">
          <span className={`type-chip ${task.type}`}>{label(task.type)}</span>
          <span className={`priority ${task.priority}`} title={`${label(task.priority)} priority`}>
            {label(task.priority)}
          </span>
        </span>
      </span>
    </>
  );
}

type CardProps = {
  task: Task;
  workers: Worker[];
  onOpen: (task: Task) => void;
  disabled: boolean;
  keyboardActive: boolean;
  onKeyboard: (event: KeyboardEvent<HTMLButtonElement>, task: Task) => void;
  suppressClick: RefObject<boolean>;
  instructions: string;
};
function TaskCard({
  task,
  workers,
  onOpen,
  disabled,
  keyboardActive,
  onKeyboard,
  suppressClick,
  instructions,
}: CardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled,
  });
  return (
    <article
      ref={setNodeRef}
      className={`task-card ${isDragging || keyboardActive ? 'drag-source' : ''}`}
      data-task-id={task.id}
    >
      <button
        ref={setActivatorNodeRef}
        className="task-open"
        {...attributes}
        {...listeners}
        aria-label={task.title}
        aria-disabled={undefined}
        aria-pressed={isDragging || keyboardActive}
        aria-describedby={instructions}
        onMouseDown={(event) => {
          suppressClick.current = false;
          listeners?.onMouseDown?.(event);
        }}
        onTouchStart={(event) => {
          suppressClick.current = false;
          listeners?.onTouchStart?.(event);
        }}
        onKeyDown={(event) => onKeyboard(event, task)}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          onOpen(task);
        }}
      >
        <TaskContents task={task} workers={workers} />
      </button>
    </article>
  );
}

function InsertionMarker({ empty = false }: { empty?: boolean }) {
  return (
    <div
      className={`drop-indicator ${empty ? 'empty-drop' : ''}`}
      data-testid="drop-indicator"
      aria-hidden="true"
    >
      <span>Drop here</span>
    </div>
  );
}

function TaskColumn({
  status,
  tasks,
  target,
  activeId,
  onCreate,
  disabled,
  ...cardProps
}: {
  status: TaskStatus;
  tasks: Task[];
  target: DropTarget | null;
  activeId: string | null;
  onCreate: (status: 'backlog' | 'todo') => void;
  disabled: boolean;
} & Omit<CardProps, 'task' | 'keyboardActive' | 'disabled'> & { keyboardId: string | null }) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}`, disabled });
  const destination = target?.status === status ? target : null;
  const empty = !tasks.some((task) => task.id !== activeId);
  return (
    <section
      ref={setNodeRef}
      data-column={status}
      aria-label={TASK_STATUS_LABELS[status]}
      className={`column ${isOver || destination ? 'drop-over' : ''}`}
    >
      <div className="column-heading">
        <span className={`status-dot ${status}`} />
        <h2>{TASK_STATUS_LABELS[status]}</h2>
        <span className="count">{tasks.length}</span>
        {(status === 'backlog' || status === 'todo') && (
          <button
            className="icon-button column-add"
            aria-label={`Add task to ${TASK_STATUS_LABELS[status]}`}
            onClick={() => onCreate(status === 'todo' ? 'todo' : 'backlog')}
            disabled={disabled}
          >
            <Plus size={16} />
          </button>
        )}
      </div>
      <div className="column-cards">
        {tasks.map((task) => (
          <Fragment key={task.id}>
            {destination?.before === task.id && <InsertionMarker />}
            <TaskCard
              {...cardProps}
              task={task}
              disabled={disabled}
              keyboardActive={cardProps.keyboardId === task.id}
            />
          </Fragment>
        ))}
        {destination && destination.before === null && <InsertionMarker empty={empty} />}
      </div>
      {(status === 'backlog' || status === 'todo') && !tasks.length && (
        <button
          className="add-task"
          onClick={() => onCreate(status === 'todo' ? 'todo' : 'backlog')}
          disabled={disabled}
        >
          <Plus size={15} /> Add task
        </button>
      )}
    </section>
  );
}

export function BoardDnd({
  tasks,
  workers,
  onOpen,
  onCreate,
  onMove,
  disabled,
}: {
  tasks: Task[];
  workers: Worker[];
  onOpen: (task: Task) => void;
  onCreate: (status: 'backlog' | 'todo') => void;
  onMove: (task: Task, status: TaskStatus, before: string | null) => void;
  disabled: boolean;
}) {
  const board = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const pendingFocus = useRef<{ id: string; status: TaskStatus } | null>(null);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const card = Array.from(
      board.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? [],
    ).find((element) => element.dataset.taskId === pending.id);
    const focused = document.activeElement;
    if (
      focused === document.body ||
      focused?.closest('[data-task-id]')?.getAttribute('data-task-id') === pending.id
    ) {
      card?.querySelector<HTMLElement>('.task-open')?.focus();
    }
    if (!disabled) pendingFocus.current = null;
  }, [tasks, disabled]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [keyboardId, setKeyboardId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const instructions = useId();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  useEffect(() => {
    if (keyboardId && target) {
      board.current?.querySelector('[data-testid="drop-indicator"]')?.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [keyboardId, target]);
  const activeTask = tasks.find((task) => task.id === activeId);
  const collisionDetection: CollisionDetection = (args) => {
    pointer.current = args.pointerCoordinates;
    return pointerWithin(args);
  };
  const describe = (next: DropTarget) => {
    const before = tasks.find((task) => task.id === next.before);
    return `${TASK_STATUS_LABELS[next.status]}, ${before ? `before ${before.title}` : 'at the end'}`;
  };
  const updateTarget = (next: DropTarget | null) => {
    setTarget((previous) =>
      previous?.status === next?.status && previous?.before === next?.before ? previous : next,
    );
    if (next) setAnnouncement(`Drop in ${describe(next)}.`);
  };
  const pointerTarget = (event: DragMoveEvent | DragEndEvent): DropTarget | null => {
    if (!event.over || !pointer.current) return null;
    const status = TaskStatusSchema.safeParse(String(event.over.id).replace('column:', ''));
    if (!status.success) return null;
    const cards = Array.from(
      board.current?.querySelectorAll<HTMLElement>(
        `[data-column="${status.data}"] [data-task-id]`,
      ) ?? [],
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.dataset.taskId ?? '', top: rect.top, height: rect.height };
    });
    return targetAtPointer(status.data, String(event.active.id), pointer.current.y, cards);
  };
  const finish = (task: Task | undefined, destination: DropTarget | null) => {
    setActiveId(null);
    setKeyboardId(null);
    setTarget(null);
    if (task && destination && !disabled) {
      if (!isSamePosition(task, destination, tasks))
        onMove(task, destination.status, destination.before);
      setAnnouncement(`Placed ${task.title} in ${describe(destination)}.`);
    } else setAnnouncement('Move cancelled.');
  };
  const onKeyboard = (event: KeyboardEvent<HTMLButtonElement>, task: Task) => {
    if (!keyboardId) {
      if (event.key === 'Enter') {
        suppressClick.current = false;
        return;
      }
      if (event.key !== ' ' || disabled) return;
      event.preventDefault();
      suppressClick.current = true;
      const source = orderedTasks(tasks, task.status);
      setActiveId(task.id);
      setKeyboardId(task.id);
      updateTarget({
        status: task.status,
        before: source[source.findIndex((item) => item.id === task.id) + 1]?.id ?? null,
      });
      return;
    }
    if (keyboardId !== task.id || !target) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      finish(undefined, null);
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      pendingFocus.current =
        !disabled && !isSamePosition(task, target, tasks)
          ? { id: task.id, status: target.status }
          : null;
      finish(task, target);
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const destination = orderedTasks(tasks, target.status, task.id);
    let index = target.before
      ? destination.findIndex((item) => item.id === target.before)
      : destination.length;
    let status = target.status;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const statuses = TaskStatusSchema.options;
      const next = statuses[statuses.indexOf(status) + (event.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      status = next;
    } else index += event.key === 'ArrowDown' ? 1 : -1;
    const nextTasks = orderedTasks(tasks, status, task.id);
    index = Math.max(0, Math.min(index, nextTasks.length));
    updateTarget({ status, before: nextTasks[index]?.id ?? null });
  };
  return (
    <>
      <p id={instructions} className="sr-only">
        Enter opens the task. Space picks it up. Arrow keys choose a position. Space drops it.
        Escape cancels.
      </p>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={({ active }) => {
          suppressClick.current = true;
          setActiveId(String(active.id));
          setKeyboardId(null);
          setAnnouncement('Task picked up.');
        }}
        onDragMove={(event) => updateTarget(pointerTarget(event))}
        onDragOver={(event) => updateTarget(pointerTarget(event))}
        onDragCancel={() => finish(undefined, null)}
        onDragEnd={(event) =>
          finish(
            tasks.find((task) => task.id === event.active.id),
            pointerTarget(event),
          )
        }
      >
        <div className="board-grid" ref={board}>
          {TaskStatusSchema.options.map((status) => (
            <TaskColumn
              key={status}
              status={status}
              tasks={orderedTasks(tasks, status)}
              workers={workers}
              onOpen={onOpen}
              onCreate={onCreate}
              disabled={disabled}
              target={target}
              activeId={activeId}
              keyboardId={keyboardId}
              onKeyboard={onKeyboard}
              suppressClick={suppressClick}
              instructions={instructions}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeTask && !keyboardId && (
            <div className="task-card drag-preview" aria-hidden="true">
              <TaskContents task={activeTask} workers={workers} />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </>
  );
}
