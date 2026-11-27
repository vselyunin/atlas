import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiToBoardSessionMessageSchema,
  DEFAULT_SESSION_SIZE,
  taskSessionPath,
} from '@atlas/contracts';
import type { ApiToBoardSessionMessage, BoardToApiSessionMessage } from '@atlas/contracts';

export type SessionMessage = Extract<ApiToBoardSessionMessage, { type: 'session' }>;

/** A light socket for the task panel: the live summary and a way to start. Closed on unmount. */
export function useTaskSession(taskId: string) {
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState<SessionMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}${taskSessionPath(taskId)}`);
    socketRef.current = socket;
    let closing = false;
    socket.addEventListener('open', () => {
      setConnected(true);
      setError(null);
    });
    socket.addEventListener('close', () => {
      if (closing) return;
      setConnected(false);
      setError('Connection lost. Close and reopen the task to reconnect.');
    });
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
      if (message.type === 'session') {
        setInfo(message);
        setError(null);
      } else if (message.type === 'error') {
        setError(message.message);
      }
    });
    return () => {
      closing = true;
      socket.close();
      socketRef.current = null;
      setInfo(null);
      setConnected(false);
    };
  }, [taskId]);

  const start = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const message: BoardToApiSessionMessage = { type: 'start', ...DEFAULT_SESSION_SIZE };
    socket.send(JSON.stringify(message));
  }, []);

  return { connected, info, error, start };
}
