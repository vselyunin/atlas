import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { CollisionDetection, DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, UserRound, Bot } from 'lucide-react';
import { TaskStatusSchema, TASK_STATUS_LABELS } from '@atlas/contracts';
import type { Task, TaskStatus, Worker } from '@atlas/contracts';
import { label } from '../tasks/TaskFields';

// Tall columns have distant corners: use the pointer's actual target for mouse
// and touch input, while retaining geometry-based detection for keyboard moves.
const boardCollisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const cards = hits.filter((hit) => !String(hit.id).startsWith('column:'));
  return cards.length ? cards : hits.length ? hits : closestCorners(args);
};

function TaskCard({
  task,
  workers,
  onOpen,
  disabled,
}: {
  task: Task;
  workers: Worker[];
  onOpen: (task: Task) => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled,
  });
  const worker = workers.find((item) => item.id === task.assigneeId);
  return (
    <article
      ref={setNodeRef}
      className={`task-card ${isDragging ? 'dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-task-id={task.id}
    >
      <div className="card-top">
        <button className="task-title" onClick={() => onOpen(task)}>
          {task.title}
        </button>
        <button
          className="drag-handle"
          aria-label={`Move ${task.title}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={15} />
        </button>
      </div>
      {task.description && <p className="card-description">{task.description}</p>}
      <div className="card-footer">
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
      </div>
    </article>
  );
}
function TaskColumn({
  status,
  tasks,
  workers,
  onOpen,
  onCreate,
  disabled,
}: {
  status: TaskStatus;
  tasks: Task[];
  workers: Worker[];
  onOpen: (task: Task) => void;
  onCreate: () => void;
  disabled: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}`, disabled });
  return (
    <section
      ref={setNodeRef}
      aria-label={TASK_STATUS_LABELS[status]}
      className={`column ${isOver ? 'drop-over' : ''}`}
    >
      <div className="column-heading">
        <span className={`status-dot ${status}`} />
        <h2>{TASK_STATUS_LABELS[status]}</h2>
        <span className="count">{tasks.length}</span>
        {status === 'backlog' && (
          <button
            className="icon-button column-add"
            aria-label="Add task to Backlog"
            onClick={onCreate}
            disabled={disabled}
          >
            <Plus size={16} />
          </button>
        )}
      </div>
      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <div className="column-cards">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              workers={workers}
              onOpen={onOpen}
              disabled={disabled}
            />
          ))}
          {!tasks.length && (
            <p className="column-empty">
              {status === 'backlog'
                ? 'Your next idea starts here'
                : status === 'todo'
                  ? 'Ready when you are'
                  : status === 'working'
                    ? 'Make room for progress'
                    : 'Good work lands here'}
            </p>
          )}
        </div>
      </SortableContext>
      {status === 'backlog' && (
        <button className="add-task" onClick={onCreate} disabled={disabled}>
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
  onCreate: () => void;
  onMove: (task: Task, status: TaskStatus, before: string | null) => void;
  disabled: boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || disabled) return;
    const task = tasks.find((item) => item.id === active.id);
    if (!task) return;
    const target = tasks.find((item) => item.id === over.id);
    if (target) onMove(task, target.status, target.id);
    else {
      const status = TaskStatusSchema.safeParse(String(over.id).replace('column:', ''));
      if (status.success) onMove(task, status.data, null);
    }
  };
  return (
    <DndContext sensors={sensors} collisionDetection={boardCollisionDetection} onDragEnd={onEnd}>
      <div className="board-grid">
        {TaskStatusSchema.options.map((status) => (
          <TaskColumn
            key={status}
            status={status}
            tasks={tasks
              .filter((task) => task.status === status)
              .sort((a, b) => a.position - b.position)}
            workers={workers}
            onOpen={onOpen}
            onCreate={onCreate}
            disabled={disabled}
          />
        ))}
      </div>
    </DndContext>
  );
}
