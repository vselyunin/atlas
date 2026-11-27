// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { taskSessionPath } from '@atlas/contracts';
import { Dialog } from '../src/components/ui/dialog';
import { TaskSession } from '../src/features/sessions/TaskSession';
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

const running = {
  type: 'session',
  state: 'running',
  branch: null,
  worktreePath: null,
  exitCode: null,
  message: null,
  status: 'working',
  reason: 'working',
  since: null,
};

function renderPanel() {
  render(<TaskSession taskId="task:one" taskStatus="working" />);
  const panel = sockets.last();
  act(() => panel.open());
  act(() => panel.receive(running));
  return panel;
}

it('loads the terminal on demand and closes its socket when hidden', async () => {
  const user = userEvent.setup();
  const panel = renderPanel();
  expect(sockets.sockets).toHaveLength(1);
  expect(panel.url.endsWith(taskSessionPath('task:one'))).toBe(true);

  await user.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Hide terminal' })).toBeTruthy();
  const socket = sockets.last();
  expect(socket).not.toBe(panel);
  expect(socket.url.endsWith(taskSessionPath('task:one'))).toBe(true);
  expect(socket.closed).toBe(false);

  await user.click(screen.getByRole('button', { name: 'Hide terminal' }));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  expect(socket.closed).toBe(true);
  expect(panel.closed).toBe(false);
});

it('keeps Escape inside the terminal from closing a dialog, but not elsewhere', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <Dialog title="Task" description="Task details" onClose={onClose}>
      <button type="button">Elsewhere</button>
      <TaskSession taskId="task:one" taskStatus="working" />
    </Dialog>,
  );
  act(() => sockets.last().open());
  act(() => sockets.last().receive(running));
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByRole('status');
  act(() => sockets.last().open());

  const screenElement = document.querySelector('.session-screen') as HTMLElement;
  const field = screenElement.querySelector('textarea') as HTMLElement;
  act(() => field.focus());
  expect(document.activeElement).toBe(field);
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();

  act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
});
