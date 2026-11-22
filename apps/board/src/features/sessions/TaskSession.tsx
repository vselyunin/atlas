import { lazy, Suspense, useState } from 'react';

// Spike: the terminal and its socket load only when asked for.
const SessionTerminal = lazy(() => import('./SessionTerminal'));

export function TaskSession({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="session" aria-label="Agent session">
      <div className="session-heading">
        <h3>Agent session</h3>
        <button type="button" className="button" onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide terminal' : 'Open terminal'}
        </button>
      </div>
      {open && (
        <Suspense fallback={<p className="field-note">Loading terminal…</p>}>
          <SessionTerminal taskId={taskId} />
        </Suspense>
      )}
    </section>
  );
}
