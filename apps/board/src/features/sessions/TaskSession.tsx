import { lazy, Suspense, useEffect, useState } from 'react';
import type { TaskStatus } from '@atlas/contracts';
import { StatusDot, statusSentence } from './status';
import { useTaskSession } from './useTaskSession';
import type { SessionMessage } from './useTaskSession';

// Spike: the terminal and its socket load only when asked for.
const SessionTerminal = lazy(() => import('./SessionTerminal'));

export function TaskSession({
  taskId,
  taskStatus,
  onInfo,
}: {
  taskId: string;
  taskStatus: TaskStatus;
  /** Reports the live session summary to the parent, so it needs no socket of its own. */
  onInfo?: (info: SessionMessage | null) => void;
}) {
  const { connected, info, error, errorCount, start } = useTaskSession(taskId);
  const [open, setOpen] = useState(false);
  // What was current when start was sent; the button stays off until a newer session message
  // or error arrives (a refused start answers with an error and creates no session).
  const [startedAt, setStartedAt] = useState<{
    info: SessionMessage | null;
    errorCount: number;
  } | null>(null);

  useEffect(() => {
    onInfo?.(info);
  }, [info, onInfo]);

  const state = info?.state ?? 'none';
  const live = state === 'starting' || state === 'running';
  const working = taskStatus === 'working';
  const startLabel =
    !working || !info
      ? null
      : state === 'none' && info.reason !== 'no_checkout'
        ? 'Start session'
        : state === 'exited'
          ? 'Resume session'
          : null;
  const toggleLabel = open ? 'Hide terminal' : live ? 'Connect' : 'Show last output';
  const hasToggle = live || state === 'exited' || open;
  const waiting = startedAt?.info === info && startedAt.errorCount === errorCount;

  return (
    <section className="session" aria-label="Agent session">
      <div className="session-heading">
        <h3>Agent session</h3>
        <div className="session-actions">
          {startLabel && (
            <button
              type="button"
              className="button primary"
              disabled={!connected || waiting}
              onClick={() => {
                setStartedAt({ info, errorCount });
                start();
                setOpen(true);
              }}
            >
              {startLabel}
            </button>
          )}
          {hasToggle && (
            <button type="button" className="button" onClick={() => setOpen((value) => !value)}>
              {toggleLabel}
            </button>
          )}
        </div>
      </div>
      {info ? (
        <p className="session-summary">
          <StatusDot summary={info} /> {statusSentence(info)}
        </p>
      ) : (
        !error && <p className="field-note">Connecting…</p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {open && (
        <Suspense fallback={<p className="field-note">Loading terminal…</p>}>
          <SessionTerminal taskId={taskId} />
        </Suspense>
      )}
    </section>
  );
}
