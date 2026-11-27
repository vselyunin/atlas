// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { REPOSITORY_CLONE_CAPABILITY, makeWorkerFixture } from '@atlas/contracts';
import { CreateProjectDialog } from '../src/features/projects/CreateProjectDialog';

const user = { id: 'u1', login: 'octocat', name: null, avatarUrl: null, role: 'owner' as const };
const repositories = [
  { id: 11, fullName: 'octo-org/atlas', private: true, defaultBranch: 'main' },
  { id: 12, fullName: 'octo-org/other', private: false, defaultBranch: 'trunk' },
];
const cloner = makeWorkerFixture({
  id: 'atlas:cloner',
  name: 'Cloner',
  capabilities: [REPOSITORY_CLONE_CAPABILITY],
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

it('drops a clone refusal once another repository is chosen', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const path = input.replace('/api/v1', '');
      if (path === '/auth/state')
        return Promise.resolve(respond({ auth: 'github', setup: 'done', user, app: null }));
      if (path === '/github/repositories') return Promise.resolve(respond({ items: repositories }));
      if (path === '/projects' && init?.method === 'POST')
        return Promise.resolve(
          respond({ error: { code: 'repository_not_accessible', message: 'refused' } }, 403),
        );
      return Promise.resolve(respond({ error: { code: 'not_found', message: 'nope' } }, 404));
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CreateProjectDialog workers={[cloner]} onClose={vi.fn()} onCreated={vi.fn()} />
    </QueryClientProvider>,
  );
  const person = userEvent.setup();
  await person.type(screen.getByLabelText('Project name'), 'Cloned');
  await person.click(await screen.findByRole('button', { name: /Clone from GitHub/ }));
  const picker = await screen.findByLabelText('Repository');
  await person.selectOptions(picker, 'octo-org/atlas');
  await person.click(screen.getByRole('button', { name: 'Create project' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/cannot reach that repository/);

  // Typing elsewhere keeps the refusal: it is still about the chosen repository.
  await person.type(screen.getByLabelText('Project name'), '!');
  expect(screen.getByRole('alert').textContent).toMatch(/cannot reach that repository/);

  await person.selectOptions(await screen.findByLabelText('Repository'), 'octo-org/other');
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});
