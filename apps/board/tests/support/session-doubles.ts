import { vi } from 'vitest';

export class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly sent: unknown[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit('open', {});
  }

  receive(message: unknown) {
    this.emit('message', { data: JSON.stringify(message) });
  }

  closeFromServer() {
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', {});
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** Replaces WebSocket and ResizeObserver; undo with `vi.unstubAllGlobals()`. */
export function installFakeWebSocket() {
  const sockets: FakeSocket[] = [];
  class RecordingSocket extends FakeSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('WebSocket', RecordingSocket);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return {
    sockets,
    last(): FakeSocket {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('No WebSocket was created');
      return socket;
    },
  };
}

type DataListener = (data: string) => void;

class FakeXterm {
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  private listener: DataListener | null = null;

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    fakeTerminal.instances.push(this);
  }

  loadAddon() {}

  open(element: HTMLElement) {
    // xterm puts a focusable textarea inside its container.
    element.appendChild(document.createElement('textarea'));
  }

  write(data: string) {
    fakeTerminal.writes.push(data);
  }

  reset() {
    fakeTerminal.resets += 1;
  }

  focus() {}

  dispose() {
    fakeTerminal.disposed += 1;
  }

  onData(listener: DataListener) {
    this.listener = listener;
    return { dispose: () => (this.listener = null) };
  }

  fire(data: string) {
    this.listener?.(data);
  }
}

class FakeFitAddon {
  fit() {}
}

/** Shared recorder behind `vi.mock('@xterm/xterm')` and `vi.mock('@xterm/addon-fit')`. */
export const fakeTerminal = {
  instances: [] as FakeXterm[],
  writes: [] as string[],
  resets: 0,
  disposed: 0,
  xtermModule: { Terminal: FakeXterm },
  fitModule: { FitAddon: FakeFitAddon },
  reset() {
    this.instances.length = 0;
    this.writes.length = 0;
    this.resets = 0;
    this.disposed = 0;
  },
  /** Fires `onData` as if the user typed. */
  type(data: string) {
    const terminal = this.instances.at(-1);
    if (!terminal) throw new Error('No terminal was created');
    terminal.fire(data);
  },
};
