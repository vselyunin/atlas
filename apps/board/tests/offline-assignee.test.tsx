// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { makeTaskFixture, makeWorkerFixture } from '@atlas/contracts';
import { BoardDnd } from '../src/features/board/BoardDnd';
afterEach(cleanup);
it('makes an offline assignee explicit without requiring a hover', () => {
  const worker = makeWorkerFixture({ availability: 'offline' });
  render(
    <BoardDnd
      tasks={[makeTaskFixture({ assigneeId: worker.id })]}
      workers={[worker]}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onMove={vi.fn()}
      disabled={false}
    />,
  );
  expect(screen.getByText('Offline')).toBeTruthy();
  expect(screen.getByText(worker.name)).toBeTruthy();
});
