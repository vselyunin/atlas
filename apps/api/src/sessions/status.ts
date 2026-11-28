import type { SessionActivity, SessionActivityDetail, SessionSummary } from '@atlas/contracts';

export const WORKER_LOST_MESSAGE = 'The Worker restarted and the session was lost';

export interface StatusInput {
  session?: {
    state: 'starting' | 'running' | 'exited';
    activity: SessionActivity | null;
    detail: SessionActivityDetail | null;
    exitCode: number | null;
    message: string | null;
    stopped: boolean;
    lost: boolean;
    since: string;
  };
  failedStart?: { message: string; since: string };
  workerOnline: boolean;
  hasCheckout: boolean;
}

// Derives the one status the Board shows for a task. The first matching rule wins.
export function summarize({
  session,
  failedStart,
  workerOnline,
  hasCheckout,
}: StatusInput): SessionSummary {
  // A refusal is recorded only after the last start, so it is newer than an ended session.
  if (failedStart && (!session || session.state === 'exited')) {
    return {
      status: 'problem',
      reason: 'not_started',
      message: failedStart.message,
      exitCode: null,
      since: failedStart.since,
    };
  }
  if (!session) {
    return {
      status: 'none',
      reason: hasCheckout ? 'none' : 'no_checkout',
      message: null,
      exitCode: null,
      since: null,
    };
  }
  const { exitCode, since } = session;
  const of = (
    status: SessionSummary['status'],
    reason: SessionSummary['reason'],
    message: string | null = null,
  ): SessionSummary => ({ status, reason, message, exitCode, since });

  if (session.state === 'exited') {
    if (session.lost) return of('problem', 'worker_lost', WORKER_LOST_MESSAGE);
    if (session.stopped) return of('ended', 'stopped');
    if (exitCode === 0) return of('ended', 'exited', session.message);
    if (exitCode === null) return of('problem', 'start_failed', session.message);
    return of('problem', 'exit_error', session.message);
  }
  if (!workerOnline) return of('problem', 'worker_offline');
  if (session.state === 'starting') return of('working', 'starting');
  switch (session.activity) {
    case 'error':
      return of('problem', 'api_error', session.detail);
    case 'needs_input':
      return of('needs_input', session.detail === 'asked_in_text' ? 'asked_in_text' : 'dialog');
    case 'idle':
      return of('finished', session.detail === 'resumed' ? 'resumed' : 'finished');
    default:
      return of('working', 'working');
  }
}
