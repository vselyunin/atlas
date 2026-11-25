// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthStateResponse } from '@atlas/contracts';
import { AuthGate } from '../src/features/auth/AuthGate';

const app = {
  name: 'Atlas-ab12cd',
  account: 'octo-org',
  installUrl: 'https://github.com/apps/atlas-ab12cd/installations/new',
};
const owner = { id: 'u1', login: 'octo', name: 'Octo', avatarUrl: null, role: 'owner' as const };

function sent(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}
function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function stubApi(
  state: AuthStateResponse,
  extra: (path: string, init: RequestInit | undefined) => Response | undefined = () => undefined,
) {
  const fetchStub = vi.fn((input: string, init?: RequestInit) => {
    const path = input;
    if (path === '/api/v1/auth/state') return Promise.resolve(respond(state));
    return Promise.resolve(
      extra(path, init) ?? respond({ error: { code: 'not_found', message: 'No' } }, 404),
    );
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
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
  vi.restoreAllMocks();
});

it('shows the setup page with the one-account rules before the start button', async () => {
  stubApi({ auth: 'github', setup: 'needed', user: null, app: null });
  renderGate();
  const start = await screen.findByRole('button', { name: 'Create the GitHub App' });
  const rules = screen.getAllByRole('listitem');
  expect(rules).toHaveLength(3);
  expect(rules[0]?.textContent).toContain('exactly one GitHub account');
  expect(rules[1]?.textContent).toContain('personal account cannot reach');
  expect(rules[2]?.textContent).toContain('members of that organization');
  for (const rule of rules) {
    expect(rule.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(screen.queryByText('The board')).toBeNull();
});

it('posts the manifest to GitHub in a real form', async () => {
  const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
  const fetchStub = stubApi({ auth: 'github', setup: 'needed', user: null, app: null }, (path) =>
    path === '/api/v1/setup/github/start'
      ? respond({ action: 'https://github.com/settings/apps/new?state=s1', manifest: '{"a":1}' })
      : undefined,
  );
  renderGate();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/Organization/), 'octo-org');
  await user.click(screen.getByRole('button', { name: 'Create the GitHub App' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const call = fetchStub.mock.calls.find(([path]) => path.endsWith('/setup/github/start'));
  expect(call?.[1]?.method).toBe('POST');
  expect(sent(call?.[1])).toEqual({ organization: 'octo-org' });
  const form = document.body.querySelector<HTMLFormElement>('form[hidden]');
  if (!form) throw new Error('The manifest form was not built');
  expect(form.method).toBe('post');
  expect(form.action).toBe('https://github.com/settings/apps/new?state=s1');
  expect(form.querySelector<HTMLInputElement>('input[name="manifest"]')?.value).toBe('{"a":1}');
});

it('tells the owner to delete an orphaned App after a failed setup', async () => {
  window.history.replaceState({}, '', '/?setup=failed&reason=app_rights');
  stubApi({ auth: 'github', setup: 'needed', user: null, app: null });
  renderGate();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('different permissions');
  expect(alert.textContent).toContain('Delete it in your GitHub settings');
  expect(alert.textContent).toContain('Atlas-xxxxxx');
});

it('asks for the owner code at the install and sign-in step', async () => {
  const fetchStub = stubApi({ auth: 'github', setup: 'needs_owner', user: null, app }, (path) =>
    path === '/api/v1/setup/owner-code' ? new Response(null, { status: 204 }) : undefined,
  );
  renderGate();
  expect(await screen.findByRole('heading', { name: 'Install and sign in' })).toBeTruthy();
  expect(screen.getByText('Atlas-ab12cd')).toBeTruthy();
  expect(screen.getByText(/printed|prints it in its terminal output/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Install the App on GitHub' }).getAttribute('href')).toBe(
    app.installUrl,
  );
  expect(screen.getByRole('link', { name: 'Sign in with GitHub' }).getAttribute('href')).toBe(
    '/api/v1/auth/github/start',
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Owner code'), 'abc-123');
  await user.click(screen.getByRole('button', { name: 'Use owner code' }));
  await screen.findByText(/owner code was accepted/);
  const call = fetchStub.mock.calls.find(([path]) => path.endsWith('/setup/owner-code'));
  expect(sent(call?.[1])).toEqual({ code: 'abc-123' });
  expect(screen.getByLabelText<HTMLInputElement>('Owner code').value).toBe('');
});

it('shows the sign-in page, and that an account has no access', async () => {
  window.history.replaceState({}, '', '/?signin=failed&reason=no_access&login=other');
  stubApi({ auth: 'github', setup: 'done', user: null, app: null });
  renderGate();
  const link = await screen.findByRole('link', { name: 'Sign in with GitHub' });
  expect(link.getAttribute('href')).toBe('/api/v1/auth/github/start');
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('other');
  expect(alert.textContent).toContain('no access');
  expect(screen.queryByText('The board')).toBeNull();
});

it('shows the board to a signed-in user', async () => {
  stubApi({ auth: 'github', setup: 'done', user: owner, app });
  renderGate();
  expect(await screen.findByText('The board')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows the board with a notice when sign-in is off', async () => {
  stubApi({ auth: 'off', setup: 'not_needed', user: null, app: null });
  renderGate();
  expect(await screen.findByText('The board')).toBeTruthy();
  const notice = screen.getByRole('status');
  expect(notice.textContent).toContain('Sign-in is off');
});
