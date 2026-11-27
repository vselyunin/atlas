import { describe, expect, it } from 'vitest';
import { summarize } from '../src/sessions/status.js';
import type { StatusInput } from '../src/sessions/status.js';

const SINCE = '2026-11-27T10:00:00.000Z';

type Session = NonNullable<StatusInput['session']>;

const session = (fields: Partial<Session> = {}): Session => ({
  state: 'running',
  activity: null,
  detail: null,
  exitCode: null,
  message: null,
  stopped: false,
  lost: false,
  since: SINCE,
  ...fields,
});

const status = (input: Partial<StatusInput>) =>
  summarize({ workerOnline: true, hasCheckout: true, ...input });

describe('summarize', () => {
  it('shows nothing for a project without a checkout', () => {
    expect(status({ hasCheckout: false })).toEqual({
      status: 'none',
      reason: 'no_checkout',
      message: null,
      exitCode: null,
      since: null,
    });
  });

  it('shows a refused start as a problem with its message', () => {
    expect(
      status({ failedStart: { message: 'The project worker is offline', since: SINCE } }),
    ).toEqual({
      status: 'problem',
      reason: 'not_started',
      message: 'The project worker is offline',
      exitCode: null,
      since: SINCE,
    });
  });

  it('shows nothing when there is no session', () => {
    expect(status({})).toEqual({
      status: 'none',
      reason: 'none',
      message: null,
      exitCode: null,
      since: null,
    });
  });

  it('shows a session lost in a Worker restart as a problem', () => {
    expect(status({ session: session({ state: 'exited', lost: true, stopped: true }) })).toEqual({
      status: 'problem',
      reason: 'worker_lost',
      message: 'The Worker restarted and the session was lost',
      exitCode: null,
      since: SINCE,
    });
  });

  it('shows a session the user stopped as ended', () => {
    expect(status({ session: session({ state: 'exited', stopped: true, exitCode: 143 }) })).toEqual(
      { status: 'ended', reason: 'stopped', message: null, exitCode: 143, since: SINCE },
    );
  });

  it('shows a clean exit as ended with the session message', () => {
    expect(
      status({ session: session({ state: 'exited', exitCode: 0, message: 'Commits copied' }) }),
    ).toEqual({
      status: 'ended',
      reason: 'exited',
      message: 'Commits copied',
      exitCode: 0,
      since: SINCE,
    });
  });

  it('shows an exit without a code as a failed start', () => {
    expect(
      status({ session: session({ state: 'exited', exitCode: null, message: 'No worktree' }) }),
    ).toEqual({
      status: 'problem',
      reason: 'start_failed',
      message: 'No worktree',
      exitCode: null,
      since: SINCE,
    });
  });

  it('shows a non-zero exit as a problem', () => {
    expect(status({ session: session({ state: 'exited', exitCode: 1, message: 'Boom' }) })).toEqual(
      { status: 'problem', reason: 'exit_error', message: 'Boom', exitCode: 1, since: SINCE },
    );
  });

  it('shows a live session on an offline Worker as a problem', () => {
    expect(status({ workerOnline: false, session: session({ activity: 'idle' }) })).toMatchObject({
      status: 'problem',
      reason: 'worker_offline',
      since: SINCE,
    });
  });

  it('shows a starting session as working', () => {
    expect(status({ session: session({ state: 'starting', activity: 'error' }) })).toEqual({
      status: 'working',
      reason: 'starting',
      message: null,
      exitCode: null,
      since: SINCE,
    });
  });

  it('shows an API error in a turn as a problem with its detail', () => {
    expect(status({ session: session({ activity: 'error', detail: 'rate_limit' }) })).toMatchObject(
      { status: 'problem', reason: 'api_error', message: 'rate_limit' },
    );
  });

  it('tells a dialog from a question asked in text', () => {
    expect(status({ session: session({ activity: 'needs_input' }) })).toMatchObject({
      status: 'needs_input',
      reason: 'dialog',
      message: null,
    });
    expect(
      status({ session: session({ activity: 'needs_input', detail: 'asked_in_text' }) }),
    ).toMatchObject({ status: 'needs_input', reason: 'asked_in_text' });
  });

  it('tells a finished turn from a resumed session', () => {
    expect(status({ session: session({ activity: 'idle' }) })).toMatchObject({
      status: 'finished',
      reason: 'finished',
    });
    expect(status({ session: session({ activity: 'idle', detail: 'resumed' }) })).toMatchObject({
      status: 'finished',
      reason: 'resumed',
    });
  });

  it('shows a running session as working otherwise', () => {
    for (const activity of [null, 'working'] as const) {
      expect(status({ session: session({ activity }) })).toEqual({
        status: 'working',
        reason: 'working',
        message: null,
        exitCode: null,
        since: SINCE,
      });
    }
  });

  it('prefers the session over a failed start and a missing checkout', () => {
    expect(
      status({
        hasCheckout: false,
        failedStart: { message: 'old', since: SINCE },
        session: session({ state: 'starting' }),
      }),
    ).toMatchObject({ status: 'working', reason: 'starting' });
  });
});
