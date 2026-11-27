import type { SessionStatus, SessionSummary } from '@atlas/contracts';

type StatusFields = Pick<SessionSummary, 'status' | 'reason' | 'message' | 'exitCode' | 'since'>;

const LABELS: Record<Exclude<SessionStatus, 'none'>, string> = {
  working: 'Agent working',
  needs_input: 'Agent needs you',
  finished: 'Agent finished',
  problem: 'Agent problem',
  ended: 'Session ended',
};

const pad = (value: number) => String(value).padStart(2, '0');
function clock(since: string | null) {
  if (!since) return null;
  const date = new Date(since);
  if (Number.isNaN(date.getTime())) return null;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function statusSentence(summary: StatusFields): string {
  const time = clock(summary.since);
  const message = summary.message ?? '';
  switch (summary.reason) {
    case 'starting':
      return 'Starting…';
    case 'working':
      return time ? `Working since ${time}` : 'Working';
    case 'dialog':
      return 'Waiting for your answer';
    case 'asked_in_text':
      return 'The agent asked something in its last message (a guess from its last character)';
    case 'finished':
      return time
        ? `Finished at ${time}, waiting for your next message`
        : 'Finished, waiting for your next message';
    case 'resumed':
      return 'Resumed, waiting for your message';
    case 'not_started':
      return `Session not started: ${message}`;
    case 'start_failed':
    case 'worker_lost':
      return message;
    case 'exit_error':
      return `Agent exited with code ${summary.exitCode ?? 'unknown'}`;
    case 'api_error':
      return `Model API error: ${message.replaceAll('_', ' ')}`;
    case 'worker_offline':
      return 'Worker offline';
    case 'exited': {
      const base = `${time ? `Ended at ${time}` : 'Ended'} (exit code ${summary.exitCode ?? 0})`;
      return message ? `${base} ${message}` : base;
    }
    case 'stopped':
      return time ? `Stopped at ${time}` : 'Stopped';
    case 'no_checkout':
      return 'This project has no checkout on a worker, so no session can run';
    case 'none':
      return 'No session yet';
  }
}

export function StatusDot({ summary }: { summary: SessionSummary }) {
  if (summary.status === 'none') return null;
  const sentence = statusSentence(summary);
  return (
    <span
      className={`status-dot ${summary.status}`}
      role="img"
      aria-label={LABELS[summary.status]}
      title={sentence}
    />
  );
}
