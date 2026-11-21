import type { Task, TaskStatus } from '@atlas/contracts';

export type DropTarget = { status: TaskStatus; before: string | null };
export type CardBounds = { id: string; top: number; height: number };

export function targetAtPointer(
  status: TaskStatus,
  activeId: string,
  y: number,
  cards: CardBounds[],
): DropTarget {
  const before = cards.find((card) => card.id !== activeId && y < card.top + card.height / 2);
  return { status, before: before?.id ?? null };
}

export function orderedTasks(tasks: Task[], status: TaskStatus, excludeId?: string): Task[] {
  return tasks
    .filter((task) => task.status === status && task.id !== excludeId)
    .sort((a, b) => a.position - b.position);
}

export function isSamePosition(task: Task, target: DropTarget, tasks: Task[]): boolean {
  const source = orderedTasks(tasks, task.status);
  const next = source[source.findIndex((item) => item.id === task.id) + 1]?.id ?? null;
  return task.status === target.status && next === target.before;
}
