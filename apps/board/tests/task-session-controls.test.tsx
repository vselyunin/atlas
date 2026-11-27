// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { makeTaskFixture } from '@atlas/contracts';
import type { SessionReason, SessionState, SessionStatus, TaskStatus } from '@atlas/contracts';
import { TaskSession } from '../src/features/sessions/TaskSession';
import { TaskDetails } from '../src/features/tasks/TaskDetails';
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
});

const session = (
  state: SessionState,
  status: SessionStatus,
  reason: SessionReason,
  message: string | null = null,
) => ({
  type: 'session',
  state,
  branch: null,
  worktreePath: null,
  exitCode: state === 'exited' ? 0 : null,
  message,
  status,
  reason,
  since: null,
});

function mount(taskStatus: TaskStatus) {
  render(<TaskSession taskId="task:one" taskStatus={taskStatus} />);
  const socket = sockets.last();
  act(() => socket.open());
  return socket;
}
const send = (socket: ReturnType<typeof mount>, message: unknown) =>
  act(() => socket.receive(message));
const buttonNames = () => screen.queryAllByRole('button').map((b) => b.textContent);
const startButton = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });

describe('TaskSession controls', () => {
  it('shows a neutral line and no buttons before the first session message', () => {
    mount('working');
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect(buttonNames()).toEqual([]);
  });

  it('shows the status dot and sentence', () => {
    const socket = mount('working');
    send(socket, session('running', 'needs_input', 'dialog'));
    expect(screen.getByRole('img', { name: 'Agent needs you' })).toBeTruthy();
    expect(screen.getByText('Waiting for your answer')).toBeTruthy();
  });

  it.each(['backlog', 'todo', 'working', 'done'] as const)(
    'toggles Connect and Hide terminal for a running session in %s without sending',
    async (column) => {
      const user = userEvent.setup();
      const socket = mount(column);
      send(socket, session('running', 'working', 'working'));
      expect(buttonNames()).toEqual(['Connect']);
      await user.click(screen.getByRole('button', { name: 'Connect' }));
      expect(await screen.findByRole('button', { name: 'Hide terminal' })).toBeTruthy();
      expect(socket.sent).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Hide terminal' }));
      expect(buttonNames()).toEqual(['Connect']);
      expect(socket.sent).toEqual([]);
    },
  );

  it('offers Connect while starting', () => {
    const socket = mount('todo');
    send(socket, session('starting', 'working', 'starting'));
    expect(buttonNames()).toEqual(['Connect']);
  });

  it('offers Start session in Working with no session, sending one start and opening the terminal', async () => {
    const user = userEvent.setup();
    const socket = mount('working');
    send(socket, session('none', 'none', 'none'));
    expect(buttonNames()).toEqual(['Start session']);
    await user.dblClick(screen.getByRole('button', { name: 'Start session' }));
    expect(socket.sent).toEqual([{ type: 'start', cols: 120, rows: 30 }]);
    expect(await screen.findByRole('button', { name: 'Hide terminal' })).toBeTruthy();
    expect(sockets.sockets).toHaveLength(2);
  });

  it('keeps Start session off until the next session message arrives', async () => {
    const user = userEvent.setup();
    const socket = mount('working');
    send(socket, session('none', 'problem', 'not_started', 'Worker is offline'));
    expect(screen.getByText('Session not started: Worker is offline')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(startButton('Start session').disabled).toBe(true);
    send(socket, session('none', 'problem', 'not_started', 'Worker is offline'));
    expect(startButton('Start session').disabled).toBe(false);
  });

  it('offers Resume session and Show last output for an exited session in Working', async () => {
    const user = userEvent.setup();
    const socket = mount('working');
    send(socket, session('exited', 'ended', 'exited'));
    expect(buttonNames()).toEqual(['Resume session', 'Show last output']);
    await user.click(screen.getByRole('button', { name: 'Resume session' }));
    expect(socket.sent).toEqual([{ type: 'start', cols: 120, rows: 30 }]);
  });

  it('sends one start for a double click on Resume session', async () => {
    const user = userEvent.setup();
    const socket = mount('working');
    send(socket, session('exited', 'ended', 'exited'));
    await user.dblClick(screen.getByRole('button', { name: 'Resume session' }));
    expect(socket.sent).toEqual([{ type: 'start', cols: 120, rows: 30 }]);
  });

  it('shows only Show last output for an exited session in To do, sending nothing', async () => {
    const user = userEvent.setup();
    const socket = mount('todo');
    send(socket, session('exited', 'ended', 'exited'));
    expect(buttonNames()).toEqual(['Show last output']);
    await user.click(screen.getByRole('button', { name: 'Show last output' }));
    expect(await screen.findByRole('button', { name: 'Hide terminal' })).toBeTruthy();
    expect(socket.sent).toEqual([]);
  });

  it('shows no button when the project has no checkout', () => {
    const socket = mount('working');
    send(socket, session('none', 'none', 'no_checkout'));
    expect(buttonNames()).toEqual([]);
    expect(screen.getByText(/no checkout on a worker/)).toBeTruthy();
  });

  it.each(['backlog', 'todo', 'done'] as const)(
    'shows no button for no session in %s',
    (column) => {
      const socket = mount(column);
      send(socket, session('none', 'none', 'none'));
      expect(buttonNames()).toEqual([]);
    },
  );

  it('closes its socket on unmount', () => {
    const socket = mount('working');
    cleanup();
    expect(socket.closed).toBe(true);
  });
});

describe('TaskDetails description note', () => {
  const note = 'The agent got the description when its session first started.';

  function mountDetails() {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <TaskDetails
          task={makeTaskFixture({ status: 'working' })}
          workers={[]}
          versions={[]}
          onClose={vi.fn()}
          onMove={vi.fn()}
          moving={false}
        />
      </QueryClientProvider>,
    );
    const socket = sockets.last();
    act(() => socket.open());
    return socket;
  }

  it('appears only once the task has a session', () => {
    const socket = mountDetails();
    expect(screen.queryByText(new RegExp(note))).toBeNull();
    send(socket, session('none', 'none', 'none'));
    expect(screen.queryByText(new RegExp(note))).toBeNull();
    send(socket, session('running', 'working', 'working'));
    expect(screen.getByText(`${note} Later edits do not reach it.`)).toBeTruthy();
    expect(sockets.sockets).toHaveLength(1);
  });
});
