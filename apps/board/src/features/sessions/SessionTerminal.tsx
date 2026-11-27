import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  ApiToBoardSessionMessageSchema,
  MAX_SESSION_INPUT_CHARS,
  taskSessionPath,
} from '@atlas/contracts';
import type { BoardToApiSessionMessage, SessionState } from '@atlas/contracts';

interface SessionInfo {
  state: SessionState;
  branch: string | null;
  worktreePath: string | null;
  exitCode: number | null;
  message: string | null;
}

const STATE_LABELS: Readonly<Record<SessionState, string>> = {
  none: 'No session yet',
  starting: 'Starting…',
  running: 'Running',
  exited: 'Ended',
};

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: color('--subtle'),
    foreground: color('--text'),
    cursor: color('--text'),
    cursorAccent: color('--subtle'),
    selectionBackground: color('--drop-bg'),
  };
}

export default function SessionTerminal({ taskId }: { taskId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const control = useRef<{ send(message: BoardToApiSessionMessage): void; size(): void }>(null);
  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}${taskSessionPath(taskId)}`);
    const send = (message: BoardToApiSessionMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const size = () => {
      fit.fit();
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    };
    control.current = { send, size };

    let state: SessionState = 'none';
    socket.addEventListener('open', () => {
      setConnected(true);
      size();
    });
    socket.addEventListener('close', () => setConnected(false));
    socket.addEventListener('message', (event) => {
      let input: unknown;
      try {
        input = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const parsed = ApiToBoardSessionMessageSchema.safeParse(input);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === 'output') terminal.write(message.data);
      else if (message.type === 'error') setError(message.message);
      else {
        if (message.state === 'starting') terminal.reset();
        if (message.state === 'running' && state !== 'running') size();
        state = message.state;
        setInfo(message);
        setError(null);
      }
    });
    const typing = terminal.onData((data) => {
      if (state !== 'running') return;
      for (let offset = 0; offset < data.length; offset += MAX_SESSION_INPUT_CHARS) {
        send({ type: 'input', data: data.slice(offset, offset + MAX_SESSION_INPUT_CHARS) });
      }
    });
    const observer = new ResizeObserver(size);
    observer.observe(element);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      themeObserver.disconnect();
      observer.disconnect();
      typing.dispose();
      socket.close();
      terminal.dispose();
      control.current = null;
    };
  }, [taskId]);

  const state = info?.state ?? 'none';
  const active = state === 'starting' || state === 'running';
  return (
    <div className="session-terminal">
      <div className="session-status">
        <p role="status">
          {connected ? STATE_LABELS[state] : 'Not connected to the API'}
          {state === 'exited' && info?.exitCode !== null && ` (exit code ${info?.exitCode})`}
          {info?.branch && ` · ${info.branch}`}
        </p>
        {active && (
          <button
            type="button"
            className="button"
            disabled={!connected}
            onClick={() => control.current?.send({ type: 'stop' })}
          >
            Stop
          </button>
        )}
      </div>
      {info?.worktreePath && <p className="field-note">Worktree: {info.worktreePath}</p>}
      {(error ?? info?.message) && (
        <p role="alert" className="error">
          {error ?? info?.message}
        </p>
      )}
      <div className="session-frame">
        <div
          ref={container}
          className={active && connected ? 'session-screen' : 'session-screen idle'}
        />
        {!(active && connected) && (
          <p className="session-overlay">
            {!connected
              ? 'Not connected to the API. Hide and open the terminal to reconnect.'
              : 'This session is not running.'}
          </p>
        )}
      </div>
    </div>
  );
}
