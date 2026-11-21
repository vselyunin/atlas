// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTaskFixture, makeHumanWorkerFixture } from '@atlas/contracts';
import { BoardDnd } from '../src/features/board/BoardDnd';
afterEach(cleanup);
it('keeps task type beside priority in the footer and preserves task and drag actions', async () => {
  const task = makeTaskFixture({
    title: 'Theme task',
    type: 'epic',
    priority: 'high',
    assigneeId: 'human:vladi',
  });
  const onOpen = vi.fn();
  render(
    <BoardDnd
      tasks={[task]}
      workers={[makeHumanWorkerFixture()]}
      onOpen={onOpen}
      onCreate={vi.fn()}
      onMove={vi.fn()}
      disabled={false}
    />,
  );
  const card = screen.getByRole('article');
  const footer = card.querySelector<HTMLElement>('.card-footer');
  if (!footer) throw new Error('Missing task footer');
  expect(within(footer).getByText('Epic')).toBeTruthy();
  expect(within(footer).getByText('High')).toBeTruthy();
  expect(within(footer).getByText('Vladi')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Theme task' }).getAttribute('aria-roledescription'),
  ).toBe('draggable');
  await userEvent.click(within(footer).getByText('High'));
  expect(onOpen).toHaveBeenCalledWith(task);
});
