// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GithubLink, Project, User } from '@atlas/contracts';
import { App } from '../src/App';
import { SettingsDialog } from '../src/features/auth/SettingsDialog';

const member: User = { id: 'u2', login: 'hubot', name: null, avatarUrl: null, role: 'member' };
const installUrl = 'https://github.com/apps/atlas-ab12cd/installations/new';
const connection = {
  connection: {
    name: 'Atlas-ab12cd',
    slug: 'atlas-ab12cd',
    account: 'octo-org',
    manageUrl: 'https://github.com/organizations/octo-org/settings/apps/atlas-ab12cd',
    installUrl,
  },
};
const repositories = [
  { id: 11, fullName: 'octo-org/atlas', private: true, defaultBranch: 'main' },
  { id: 12, fullName: 'octo-org/other', private: false, defaultBranch: 'trunk' },
];
const project: Project = {
  id: 'p1',
  name: 'Atlas',
  repository: { mode: 'local', localPath: '/home/a/atlas', workerId: 'w1', relativePath: 'atlas' },
  state: 'ready',
  operationId: null,
  createdAt: '2026-11-25T10:00:00.000Z',
  updatedAt: '2026-11-25T10:00:00.000Z',
};
const linked: GithubLink = {
  projectId: 'p1',
  repositoryId: 11,
  fullName: 'octo-org/atlas',
  defaultBranch: 'main',
  accessible: true,
  createdAt: '2026-11-25T10:00:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sent(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}
function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function failure(status: number, code: string) {
  return respond({ error: { code, message: `API said ${code}` } }, status);
}
type Handler = (path: string, init: RequestInit | undefined) => Response | undefined;
function stubApi(initial: GithubLink | null, extra: Handler = () => undefined) {
  let current = initial;
  const fetchStub = vi.fn((input: string, init?: RequestInit) => {
    const path = input.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const handled = extra(path, init);
    if (handled) return Promise.resolve(handled);
    if (path === '/github/connection') return Promise.resolve(respond(connection));
    if (path === '/github/repositories') return Promise.resolve(respond({ items: repositories }));
    if (path === '/projects/p1/github-link') {
      if (method === 'GET') return Promise.resolve(respond({ link: current }));
      if (method === 'POST') {
        const { repositoryId } = sent(init) as { repositoryId: number };
        const repository = repositories.find((item) => item.id === repositoryId);
        current = {
          ...linked,
          repositoryId,
          fullName: repository?.fullName ?? linked.fullName,
        };
        return Promise.resolve(respond({ link: current }, 201));
      }
      current = null;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(failure(404, 'not_found'));
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}
function renderDialog(selected: Project | null = project) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsDialog user={member} project={selected ?? undefined} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

it('links a project to a chosen repository and offers to change what the App reaches', async () => {
  const fetchStub = stubApi(null);
  renderDialog();
  const user = userEvent.setup();
  const picker = await screen.findByLabelText('Repository');
  const button = screen.getByRole('button', { name: 'Link' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen
      .getByRole('link', { name: 'Change which repositories Atlas can reach' })
      .getAttribute('href'),
  ).toBe(installUrl);

  await user.selectOptions(picker, 'octo-org/atlas');
  expect((button as HTMLButtonElement).disabled).toBe(false);
  await user.click(button);

  expect(await screen.findByText('octo-org/atlas', { selector: 'strong' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Unlink' })).toBeTruthy();
  const post = fetchStub.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post?.[0]).toBe('/api/v1/projects/p1/github-link');
  expect(sent(post?.[1])).toEqual({ repositoryId: 11 });
});

it('unlinks a linked project', async () => {
  const fetchStub = stubApi(linked);
  renderDialog();
  const user = userEvent.setup();
  expect(await screen.findByText('octo-org/atlas', { selector: 'strong' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Unlink' }));
  expect(await screen.findByLabelText('Repository')).toBeTruthy();
  const del = fetchStub.mock.calls.find(([, init]) => init?.method === 'DELETE');
  expect(del?.[0]).toBe('/api/v1/projects/p1/github-link');
  expect(del?.[1]?.body).toBe('{}');
});

it('says that the App can no longer reach a linked repository', async () => {
  stubApi({ ...linked, accessible: false });
  renderDialog();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('can no longer reach this repository');
  expect(screen.getByRole('button', { name: 'Unlink' })).toBeTruthy();
});

it('explains a refused link in plain words and keeps the choice', async () => {
  stubApi(null, (path, init) =>
    path === '/projects/p1/github-link' && init?.method === 'POST'
      ? failure(403, 'repository_not_accessible')
      : undefined,
  );
  renderDialog();
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('Repository'), 'octo-org/other');
  await user.click(screen.getByRole('button', { name: 'Link' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('cannot reach that repository');
  expect(alert.textContent).not.toContain('API said');
});

it('points to the install link when the App reaches no repositories', async () => {
  stubApi(null, (path) => (path === '/github/repositories' ? respond({ items: [] }) : undefined));
  renderDialog();
  expect(await screen.findByText(/reaches no repositories/)).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Choose repositories on GitHub' }).getAttribute('href'),
  ).toBe(installUrl);
  expect(screen.queryByLabelText('Repository')).toBeNull();
});

it('shows a failed repository list as an alert', async () => {
  stubApi(null, (path) =>
    path === '/github/repositories' ? failure(502, 'github_unavailable') : undefined,
  );
  renderDialog();
  expect((await screen.findByRole('alert')).textContent).toContain('API said github_unavailable');
});

it('shows a short message instead of the picker when no project can be linked', async () => {
  const fetchStub = stubApi(null);
  renderDialog(null);
  expect(await screen.findByText(/Select a project/)).toBeTruthy();
  expect(screen.queryByLabelText('Repository')).toBeNull();
  cleanup();

  renderDialog({ ...project, state: 'pending' });
  expect(await screen.findByText(/Only a ready project/)).toBeTruthy();
  expect(screen.queryByLabelText('Repository')).toBeNull();
  cleanup();

  renderDialog({
    ...project,
    repository: { mode: 'existing', gitUrl: 'https://example.com/a/b.git' },
  });
  expect(await screen.findByText(/Only a ready project/)).toBeTruthy();
  expect(screen.queryByLabelText('Repository')).toBeNull();
  expect(fetchStub.mock.calls.some(([path]) => path.endsWith('/github/repositories'))).toBe(false);
});

it('renders no link panel with sign-in off', async () => {
  const fetchStub = vi.fn((input: string) => {
    const path = input.replace('/api/v1', '');
    if (path === '/auth/state')
      return Promise.resolve(respond({ auth: 'off', setup: 'done', user: null, app: null }));
    if (path === '/projects') return Promise.resolve(respond({ items: [project] }));
    if (path === '/workers') return Promise.resolve(respond({ items: [] }));
    if (path === '/projects/p1/versions') return Promise.resolve(respond({ items: [] }));
    return Promise.resolve(failure(409, 'github_unavailable'));
  });
  vi.stubGlobal('fetch', fetchStub);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(fetchStub.mock.calls.some(([path]) => path.endsWith('/projects'))).toBe(true),
  );
  await screen.findByRole('main');
  await userEvent.setup().click(screen.getByRole('button', { name: 'User settings' }));
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  expect(screen.queryByText(/Repository for/)).toBeNull();
  expect(fetchStub.mock.calls.some(([path]) => path.includes('/github'))).toBe(false);
});
