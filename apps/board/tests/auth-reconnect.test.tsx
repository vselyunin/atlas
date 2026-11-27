// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthStateResponse } from '@atlas/contracts';
import { AuthGate } from '../src/features/auth/AuthGate';

// An owner exists and the GitHub connection was removed; this browser is not signed in.
const reconnect: AuthStateResponse = { auth: 'github', setup: 'reconnect', user: null, app: null };

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthGate>
        <p>The board</p>
      </AuthGate>
    </QueryClientProvider>,
  );
}

beforeEach(() => window.history.replaceState({}, '', '/'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('explains the missing connection and asks for the owner code instead of a start button', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(respond(reconnect))),
  );
  renderGate();
  expect(await screen.findByRole('heading', { name: 'Reconnect Atlas to GitHub' })).toBeTruthy();
  expect(screen.getByText(/connection to GitHub was removed/)).toBeTruthy();
  expect(screen.getByText(/nobody else becomes the owner/)).toBeTruthy();
  expect(screen.getByLabelText('Owner code')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create the GitHub App' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull();
  expect(screen.queryByText('The board')).toBeNull();
});

it('sends the code once and then offers to create the new App', async () => {
  let state: AuthStateResponse = reconnect;
  const fetchStub = vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/v1/auth/state') return Promise.resolve(respond(state));
    if (input === '/api/v1/setup/owner-code' && init?.method === 'POST') {
      // The API now reports setup as open to this browser.
      state = { ...reconnect, setup: 'needed' };
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(respond({ error: { code: 'not_found', message: 'No' } }, 404));
  });
  vi.stubGlobal('fetch', fetchStub);
  renderGate();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Owner code'), '  abc-123 ');
  await user.click(screen.getByRole('button', { name: 'Use owner code' }));

  expect(await screen.findByRole('button', { name: 'Create the GitHub App' })).toBeTruthy();
  const posts = fetchStub.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]?.[0]).toBe('/api/v1/setup/owner-code');
  const body = posts[0]?.[1]?.body;
  expect(typeof body === 'string' ? JSON.parse(body) : body).toEqual({ code: 'abc-123' });
});

it('shows why a wrong code was refused', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) =>
      Promise.resolve(
        input === '/api/v1/auth/state'
          ? respond(reconnect)
          : respond(
              { error: { code: 'owner_code_invalid', message: 'The owner code is not valid' } },
              403,
            ),
      ),
    ),
  );
  renderGate();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Owner code'), 'wrong');
  await user.click(screen.getByRole('button', { name: 'Use owner code' }));
  expect((await screen.findByRole('alert')).textContent).toContain('The owner code is not valid');
  expect(screen.getByRole('heading', { name: 'Reconnect Atlas to GitHub' })).toBeTruthy();
});
