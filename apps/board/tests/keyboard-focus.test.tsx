// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTaskFixture } from '@atlas/contracts';
import { BoardDnd } from '../src/features/board/BoardDnd';
afterEach(cleanup);
it('does not steal focus on a later refresh after a no-op keyboard drop', async () => {
  const task = makeTaskFixture({ title: 'Stay here' });
  const onMove = vi.fn();
  const props = { workers: [], onOpen: vi.fn(), onCreate: vi.fn(), onMove, disabled: false };
  const view = render(
    <>
      <button>Other action</button>
      <BoardDnd {...props} tasks={[task]} />
    </>,
  );
  const user = userEvent.setup();
  screen.getByRole('button', { name: 'Stay here' }).focus();
  await user.keyboard('  ');
  expect(onMove).not.toHaveBeenCalled();
  const other = screen.getByRole('button', { name: 'Other action' });
  other.focus();
  view.rerender(
    <>
      <button>Other action</button>
      <BoardDnd {...props} tasks={[{ ...task, description: 'Updated elsewhere' }]} />
    </>,
  );
  expect(document.activeElement).toBe(other);
});
