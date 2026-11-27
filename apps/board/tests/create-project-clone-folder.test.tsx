// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  REPOSITORY_CLONE_CAPABILITY,
  REPOSITORY_INIT_CAPABILITY,
  makeWorkerFixture,
} from '@atlas/contracts';
import { CreateProjectDialog } from '../src/features/projects/CreateProjectDialog';

// The API refuses a folder whose first part starts with a dot, so the folder proposed for a
// repository such as `.github` must not start with one.

const user = { id: 'u1', login: 'octocat', name: null, avatarUrl: null, role: 'owner' as const };
const repositories = [
  { id: 21, fullName: 'octo-org/.github', private: false, defaultBranch: 'main' },
  { id: 22, fullName: 'octo-org/..dots', private: false, defaultBranch: 'main' },
  { id: 23, fullName: 'octo-org/...', private: false, defaultBranch: 'main' },
  { id: 24, fullName: 'octo-org/atlas', private: false, defaultBranch: 'main' },
];
const cloner = makeWorkerFixture({
  id: 'atlas:cloner',
  name: 'Cloner',
  capabilities: [REPOSITORY_INIT_CAPABILITY, REPOSITORY_CLONE_CAPABILITY],
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

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = input.replace('/api/v1', '');
      if (path === '/auth/state')
        return Promise.resolve(respond({ auth: 'github', setup: 'done', user, app: null }));
      if (path === '/github/repositories') return Promise.resolve(respond({ items: repositories }));
      if (path === '/github/connection') return Promise.resolve(respond({}, 500));
      return Promise.resolve(respond({ error: { code: 'not_found', message: 'nope' } }, 404));
    }),
  );
}

async function openClone() {
  stubApi();
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
  return person;
}

const folder = () => screen.getByLabelText<HTMLInputElement>('Folder path').value;

it('proposes the repository name without its leading dots', async () => {
  const person = await openClone();
  const picker = await screen.findByLabelText('Repository');
  await person.selectOptions(picker, 'octo-org/.github');
  expect(folder()).toBe('github');
  await person.selectOptions(picker, 'octo-org/..dots');
  expect(folder()).toBe('dots');
});

it('proposes no folder when only dots are left', async () => {
  const person = await openClone();
  const picker = await screen.findByLabelText('Repository');
  await person.selectOptions(picker, 'octo-org/atlas');
  expect(folder()).toBe('atlas');
  await person.selectOptions(picker, 'octo-org/...');
  expect(folder()).toBe('');
});
