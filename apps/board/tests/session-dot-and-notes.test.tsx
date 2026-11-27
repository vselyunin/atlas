// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeTaskFixture } from '@atlas/contracts';
import type { SessionReason, SessionStatus, SessionSummary } from '@atlas/contracts';
import { BoardDnd } from '../src/features/board/BoardDnd';
import { useTaskMove } from '../src/features/board/useTaskMove';
import SessionTerminal from '../src/features/sessions/SessionTerminal';
import { TaskSession } from '../src/features/sessions/TaskSession';
import { statusSentence } from '../src/features/sessions/status';
import { sessionsKey, taskKey } from '../src/lib/queries';
import { fakeTerminal, installFakeWebSocket } from './support/session-doubles';

vi.mock(
  '@xterm/xterm',
  async () => (await import('./support/session-doubles')).fakeTerminal.xtermModule,
);
vi.mock(
  '@xterm/addon-fit',
  async () => (await import('./support/session-doubles')).fakeTerminal.fitModule,
);
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

let sockets: ReturnType<typeof installFakeWebSocket>;
beforeEach(() => {
  fakeTerminal.reset();
  sockets = installFakeWebSocket();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.head.querySelectorAll('style[data-board]').forEach((node) => node.remove());
});

const summary = (
  status: SessionStatus,
  reason: SessionReason,
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({ status, reason, message: null, exitCode: null, since: null, ...extra });
const socketMessage = (value: SessionSummary, state = 'running') => ({
  type: 'session',
  state,
  branch: null,
  worktreePath: null,
  ...value,
});

// The Board's own dot rules. jsdom cannot read the whole stylesheet (Tailwind syntax), so only
// the plain rules that name a dot class are loaded, in their source order.
function loadBoardStyles() {
  const css = (
    readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8').match(
      /[^{}]*(?:status-dot|column-dot)[^{}]*\{[^{}]*\}/g,
    ) ?? []
  ).join('\n');
  const style = document.createElement('style');
  style.dataset.board = '';
  style.textContent = css;
  document.head.append(style);
}
const background = (element: Element) =>
  getComputedStyle(element).getPropertyValue('background-color');

function renderCard(session: SessionSummary) {
  render(
    <BoardDnd
      tasks={[makeTaskFixture({ title: 'Dotted task', status: 'working' })]}
      workers={[]}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onMove={vi.fn()}
      disabled={false}
      sessions={new Map([[makeTaskFixture().id, session]])}
    />,
  );
}
function renderPanel(session: SessionSummary) {
  render(<TaskSession taskId="task:one" taskStatus="working" />);
  const socket = sockets.last();
  act(() => socket.open());
  act(() => socket.receive(socketMessage(session)));
}

describe('agent status dot', () => {
  it.each<[SessionStatus, SessionReason, string]>([
    ['working', 'working', '--status-agent-working'],
    ['needs_input', 'dialog', '--status-needs-input'],
    ['finished', 'finished', '--status-finished'],
    ['problem', 'exit_error', '--status-problem'],
    ['ended', 'stopped', '--status-ended'],
  ])(
    'uses the same class and colour for %s on the card and in the panel',
    (status, reason, token) => {
      loadBoardStyles();
      const value = summary(status, reason, { exitCode: status === 'problem' ? 1 : null });
      renderCard(value);
      renderPanel(value);
      const dots = screen.getAllByRole('img');
      expect(dots).toHaveLength(2);
      const [card, panel] = dots as [HTMLElement, HTMLElement];
      expect(card.closest('.task-title')).not.toBeNull();
      expect(panel.closest('.session-summary')).not.toBeNull();
      expect(card.className).toBe(`status-dot ${status}`);
      expect(panel.className).toBe(card.className);
      expect(background(card)).toContain(token);
      expect(background(panel)).toContain(token);
    },
  );

  it('keeps the column heading dots on their own class and colours', () => {
    loadBoardStyles();
    renderCard(summary('working', 'working'));
    const column = document.querySelector('[data-column="working"] .column-heading span');
    if (!column) throw new Error('The Working column has no heading dot');
    expect(column.className).toBe('column-dot working');
    expect(background(column)).toContain('--status-working');
    expect(background(column)).not.toContain('--status-agent-working');
  });
});

describe('status sentences without a message', () => {
  it.each<[SessionReason, string]>([
    ['not_started', 'Session not started'],
    ['start_failed', 'The session could not start'],
    ['worker_lost', 'The Worker restarted and the session was lost'],
    ['api_error', 'Model API error'],
  ])('describes %s in words', (reason, sentence) => {
    expect(statusSentence(summary('problem', reason))).toBe(sentence);
  });
});

describe('terminal notes', () => {
  function terminal(value: SessionSummary, state = 'running') {
    render(<SessionTerminal taskId="task:one" />);
    const socket = sockets.last();
    act(() => socket.open());
    act(() => socket.receive(socketMessage(value, state)));
  }

  it('shows an API error kind as words, not as its code', () => {
    terminal(summary('problem', 'api_error', { message: 'rate_limit' }));
    expect(screen.getByRole('alert').textContent).toBe('Model API error: rate limit');
  });

  it('shows a refused start as its status sentence', () => {
    terminal(
      summary('problem', 'not_started', { message: 'the project worker is offline' }),
      'none',
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'Session not started: the project worker is offline',
    );
  });

  it('shows no alert for an API error without a kind', () => {
    terminal(summary('problem', 'api_error'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the message of a session that ended with one', () => {
    terminal(summary('ended', 'exited', { exitCode: 0, message: 'Copied 2 commits' }), 'exited');
    expect(screen.getByRole('alert').textContent).toBe('Copied 2 commits');
  });
});

describe('task move', () => {
  it('refreshes the session dots of the version once a move succeeds', async () => {
    const task = makeTaskFixture({ status: 'todo' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ task: { ...task, status: 'working' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTaskMove(task.projectId, task.versionId), { wrapper });
    act(() => result.current.mutate({ task, status: 'working', before: null }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(sessionsKey(task.projectId, task.versionId));
    expect(keys).toContainEqual(taskKey(task.projectId, task.versionId));
  });
});
