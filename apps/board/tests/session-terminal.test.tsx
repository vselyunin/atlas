// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_SESSION_INPUT_CHARS, taskSessionPath } from '@atlas/contracts';
import SessionTerminal from '../src/features/sessions/SessionTerminal';
import { fakeTerminal, installFakeWebSocket } from './support/session-doubles';
import type { FakeSocket } from './support/session-doubles';

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

type State = 'none' | 'starting' | 'running' | 'exited';
const session = (
  state: State,
  extra: Partial<{
    branch: string | null;
    worktreePath: string | null;
    exitCode: number | null;
    message: string | null;
  }> = {},
) => ({
  type: 'session',
  state,
  branch: null,
  worktreePath: null,
  exitCode: null,
  message: null,
  ...extra,
});

function mount() {
  render(<SessionTerminal taskId="task:one" />);
  return sockets.last();
}
function openSocket() {
  const socket = mount();
  act(() => socket.open());
  return socket;
}
function receive(socket: FakeSocket, message: unknown) {
  act(() => socket.receive(message));
}
const status = () => screen.getByRole('status').textContent;
const screenElement = () => document.querySelector('.session-screen') as HTMLElement;

describe('SessionTerminal', () => {
  it('connects to the task session path', () => {
    const socket = mount();
    expect(socket.url.endsWith(taskSessionPath('task:one'))).toBe(true);
  });

  it('reads Not connected to the API before the socket opens', () => {
    mount();
    expect(status()).toBe('Not connected to the API');
  });

  it.each([
    ['none', 'No session yet'],
    ['starting', 'Starting…'],
    ['running', 'Running'],
    ['exited', 'Ended'],
  ] as const)('shows %s as "%s"', (state, label) => {
    const socket = openSocket();
    receive(socket, session(state));
    expect(status()).toBe(label);
  });

  it('shows the exit code and the branch', () => {
    const socket = openSocket();
    receive(socket, session('exited', { exitCode: 2, branch: 'atlas/task-one' }));
    expect(status()).toContain('Ended');
    expect(status()).toContain('(exit code 2)');
    expect(status()).toContain('· atlas/task-one');
  });

  it('offers Start session for none and Start again for exited, sending start with the size', async () => {
    const user = userEvent.setup();
    const socket = openSocket();
    receive(socket, session('none'));
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(socket.sent).toContainEqual({ type: 'start', cols: 80, rows: 24 });

    receive(socket, session('exited', { exitCode: 0 }));
    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull();
    socket.sent.length = 0;
    await user.click(screen.getByRole('button', { name: 'Start again' }));
    expect(socket.sent).toEqual([{ type: 'start', cols: 80, rows: 24 }]);
  });

  it.each(['starting', 'running'] as const)('offers Stop while %s', async (state) => {
    const user = userEvent.setup();
    const socket = openSocket();
    receive(socket, session(state));
    expect(screen.queryByRole('button', { name: /^Start/ })).toBeNull();
    socket.sent.length = 0;
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(socket.sent).toEqual([{ type: 'stop' }]);
  });

  it('sends typed input only while running', () => {
    const socket = openSocket();
    receive(socket, session('starting'));
    socket.sent.length = 0;
    fakeTerminal.type('ignored');
    expect(socket.sent).toEqual([]);

    receive(socket, session('running'));
    socket.sent.length = 0;
    fakeTerminal.type('ls\r');
    expect(socket.sent).toEqual([{ type: 'input', data: 'ls\r' }]);

    receive(socket, session('exited'));
    socket.sent.length = 0;
    fakeTerminal.type('ignored');
    expect(socket.sent).toEqual([]);
  });

  it('splits large input into messages of at most MAX_SESSION_INPUT_CHARS', () => {
    const socket = openSocket();
    receive(socket, session('running'));
    socket.sent.length = 0;
    const text = 'x'.repeat(20_000);
    fakeTerminal.type(text);
    const inputs = socket.sent as Array<{ type: string; data: string }>;
    expect(inputs.length).toBe(Math.ceil(20_000 / MAX_SESSION_INPUT_CHARS));
    expect(
      inputs.every((m) => m.type === 'input' && m.data.length <= MAX_SESSION_INPUT_CHARS),
    ).toBe(true);
    expect(inputs.map((m) => m.data).join('')).toBe(text);
  });

  it('writes output to the terminal and resets it when a session starts', () => {
    const socket = openSocket();
    receive(socket, { type: 'output', data: 'hello' });
    expect(fakeTerminal.writes).toEqual(['hello']);
    expect(fakeTerminal.resets).toBe(0);
    receive(socket, session('starting'));
    expect(fakeTerminal.resets).toBe(1);
  });

  it('shows an error message until the next session message', () => {
    const socket = openSocket();
    receive(socket, { type: 'error', message: 'Worker is offline' });
    expect(screen.getByRole('alert').textContent).toBe('Worker is offline');
    receive(socket, session('none'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is idle with an overlay unless a session is active and connected', () => {
    const socket = openSocket();
    receive(socket, session('none'));
    expect(screenElement().classList.contains('idle')).toBe(true);
    expect(document.querySelector('.session-overlay')).not.toBeNull();

    receive(socket, session('running'));
    expect(screenElement().classList.contains('idle')).toBe(false);
    expect(document.querySelector('.session-overlay')).toBeNull();

    act(() => socket.closeFromServer());
    expect(screenElement().classList.contains('idle')).toBe(true);
    expect(document.querySelector('.session-overlay')).not.toBeNull();
    expect(status()).toBe('Not connected to the API');
  });
});
