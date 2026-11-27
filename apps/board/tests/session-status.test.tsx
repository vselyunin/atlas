// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { makeTaskFixture } from '@atlas/contracts';
import type { SessionReason, SessionStatus, SessionSummary } from '@atlas/contracts';
import { BoardDnd } from '../src/features/board/BoardDnd';
import { StatusDot, statusSentence } from '../src/features/sessions/status';
afterEach(cleanup);

const SINCE = '2026-11-27T09:05:00.000Z';
const pad = (value: number) => String(value).padStart(2, '0');
const clock = `${pad(new Date(SINCE).getHours())}:${pad(new Date(SINCE).getMinutes())}`;
const summary = (
  status: SessionStatus,
  reason: SessionReason,
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({ status, reason, message: null, exitCode: null, since: SINCE, ...extra });

it.each<[string, SessionSummary, string]>([
  ['starting', summary('working', 'starting'), 'Starting…'],
  ['working', summary('working', 'working'), `Working since ${clock}`],
  ['dialog', summary('needs_input', 'dialog'), 'Waiting for your answer'],
  [
    'asked_in_text',
    summary('needs_input', 'asked_in_text'),
    'The agent asked something in its last message (a guess from its last character)',
  ],
  [
    'finished',
    summary('finished', 'finished'),
    `Finished at ${clock}, waiting for your next message`,
  ],
  ['resumed', summary('finished', 'resumed'), 'Resumed, waiting for your message'],
  [
    'not_started',
    summary('problem', 'not_started', { message: 'No checkout' }),
    'Session not started: No checkout',
  ],
  ['start_failed', summary('problem', 'start_failed', { message: 'spawn failed' }), 'spawn failed'],
  ['exit_error', summary('problem', 'exit_error', { exitCode: 2 }), 'Agent exited with code 2'],
  [
    'api_error',
    summary('problem', 'api_error', { message: 'rate_limit' }),
    'Model API error: rate limit',
  ],
  ['worker_offline', summary('problem', 'worker_offline'), 'Worker offline'],
  ['worker_lost', summary('problem', 'worker_lost', { message: 'Worker lost' }), 'Worker lost'],
  ['exited', summary('ended', 'exited', { exitCode: 0 }), `Ended at ${clock} (exit code 0)`],
  [
    'exited with message',
    summary('ended', 'exited', { exitCode: 0, message: 'Done' }),
    `Ended at ${clock} (exit code 0) Done`,
  ],
  ['stopped', summary('ended', 'stopped'), `Stopped at ${clock}`],
  [
    'no_checkout',
    summary('none', 'no_checkout', { since: null }),
    'This project has no checkout on a worker, so no session can run',
  ],
  ['none', summary('none', 'none', { since: null }), 'No session yet'],
  ['working without time', summary('working', 'working', { since: null }), 'Working'],
])('describes %s', (_name, value, sentence) => {
  expect(statusSentence(value)).toBe(sentence);
});

it('renders no dot for a task without a session', () => {
  const { container } = render(<StatusDot summary={summary('none', 'none', { since: null })} />);
  expect(container.firstChild).toBeNull();
});

const board = (session?: SessionSummary) => {
  const task = makeTaskFixture({ title: 'Dotted task' });
  render(
    <BoardDnd
      tasks={[task]}
      workers={[]}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onMove={vi.fn()}
      disabled={false}
      sessions={new Map(session ? [[task.id, session]] : [])}
    />,
  );
};

it('shows a labelled dot on a card whose session needs input', () => {
  board(summary('needs_input', 'dialog'));
  const dot = screen.getByRole('img', { name: 'Agent needs you' });
  expect(dot.className).toBe('status-dot needs_input');
  expect(dot.getAttribute('title')).toBe('Waiting for your answer');
});

it('shows no dot on a card without a session entry', () => {
  board();
  expect(screen.queryByRole('img')).toBeNull();
});

it('describes the status on the card button without changing its name', () => {
  board(summary('needs_input', 'dialog'));
  const card = screen.getByRole('button', { name: 'Dotted task' });
  expect(card).toHaveAccessibleDescription(/Agent needs you\. Waiting for your answer/);
});

it('adds no status description to a card without a session', () => {
  board();
  const card = screen.getByRole('button', { name: 'Dotted task' });
  expect(card).not.toHaveAccessibleDescription(/Agent/);
});
