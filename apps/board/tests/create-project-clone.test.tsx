// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  REPOSITORY_CLONE_CAPABILITY,
  REPOSITORY_INIT_CAPABILITY,
  makeOperationFixture,
  makeProjectFixture,
  makeWorkerFixture,
} from '@atlas/contracts';
import type { Project, Worker } from '@atlas/contracts';
import { CreateProjectDialog } from '../src/features/projects/CreateProjectDialog';
import { ProjectProvisioning } from '../src/features/projects/ProjectProvisioning';

const user = { id: 'u1', login: 'octocat', name: null, avatarUrl: null, role: 'owner' as const };
const repositories = [
  { id: 11, fullName: 'octo-org/atlas', private: true, defaultBranch: 'main' },
  { id: 12, fullName: 'octo-org/other', private: false, defaultBranch: 'trunk' },
];
const cloner = makeWorkerFixture({
  id: 'atlas:cloner',
  name: 'Cloner',
  capabilities: [REPOSITORY_INIT_CAPABILITY, REPOSITORY_CLONE_CAPABILITY],
});
const initOnly = makeWorkerFixture({ id: 'atlas:old', name: 'Old worker' });

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
function stubApi(options: { auth?: 'github' | 'off'; link?: unknown; create?: () => Response }) {
  const fetchStub = vi.fn((input: string, init?: RequestInit) => {
    const path = input.replace('/api/v1', '');
    if (path === '/auth/state') {
      const on = (options.auth ?? 'github') === 'github';
      return Promise.resolve(
        respond({ auth: on ? 'github' : 'off', setup: 'done', user: on ? user : null, app: null }),
      );
    }
    if (path === '/github/repositories') return Promise.resolve(respond({ items: repositories }));
    if (path === '/github/connection') return Promise.resolve(respond({}, 500));
    if (path.endsWith('/github-link')) return Promise.resolve(respond({ link: options.link }));
    if (path === '/projects' && init?.method === 'POST')
      return Promise.resolve(options.create?.() ?? respond({}, 500));
    if (path.startsWith('/operations/'))
      return Promise.resolve(respond({ operation: makeOperationFixture() }));
    return Promise.resolve(respond({ error: { code: 'not_found', message: 'nope' } }, 404));
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}
function wrap(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
function renderDialog(workers: Worker[], onCreated = vi.fn()) {
  wrap(<CreateProjectDialog workers={workers} onClose={vi.fn()} onCreated={onCreated} />);
  return onCreated;
}
function posted(fetchStub: ReturnType<typeof stubApi>): unknown {
  const call = fetchStub.mock.calls.find(([, init]) => init?.method === 'POST');
  return call && typeof call[1]?.body === 'string'
    ? (JSON.parse(call[1].body) as unknown)
    : undefined;
}
async function openClone() {
  const person = userEvent.setup();
  await person.type(screen.getByLabelText('Project name'), 'Cloned');
  await person.click(await screen.findByRole('button', { name: /Clone from GitHub/ }));
  return person;
}
const submit = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Create project' });

it('clones the chosen repository onto a Worker that can clone, with the name as the folder', async () => {
  const fetchStub = stubApi({
    create: () =>
      respond(
        {
          project: makeProjectFixture({ id: 'p9', state: 'pending', operationId: 'o1' }),
          operation: makeOperationFixture({ id: 'o1' }),
        },
        202,
      ),
  });
  const onCreated = renderDialog([initOnly, cloner]);
  const person = await openClone();
  await person.selectOptions(await screen.findByLabelText('Repository'), 'octo-org/atlas');

  expect(screen.getByLabelText<HTMLInputElement>('Folder path').value).toBe('atlas');
  const workerSelect = screen.getByLabelText<HTMLSelectElement>('Atlas worker');
  expect([...workerSelect.options].map((option) => option.text)).toEqual([
    'Select an online worker',
    'Cloner',
  ]);
  // The only Worker that can clone is already chosen.
  expect(submit().disabled).toBe(false);
  await person.click(submit());

  await waitFor(() => expect(onCreated).toHaveBeenCalledWith('p9'));
  expect(posted(fetchStub)).toEqual({
    name: 'Cloned',
    repository: {
      mode: 'local',
      workerId: 'atlas:cloner',
      relativePath: 'atlas',
      githubRepositoryId: 11,
    },
  });
});

it('waits for a repository, a Worker and a folder before it can submit', async () => {
  stubApi({});
  renderDialog([
    cloner,
    makeWorkerFixture({
      id: 'atlas:two',
      name: 'Two',
      capabilities: [REPOSITORY_CLONE_CAPABILITY],
    }),
  ]);
  const person = await openClone();
  expect(submit().disabled).toBe(true);
  await person.selectOptions(await screen.findByLabelText('Repository'), 'octo-org/atlas');
  expect(submit().disabled).toBe(true);
  await person.selectOptions(screen.getByLabelText('Atlas worker'), 'Cloner');
  expect(submit().disabled).toBe(false);
  await person.clear(screen.getByLabelText('Folder path'));
  expect(submit().disabled).toBe(true);
});

it('keeps a folder the person typed when another repository is chosen', async () => {
  stubApi({});
  renderDialog([cloner]);
  const person = await openClone();
  const picker = await screen.findByLabelText('Repository');
  await person.selectOptions(picker, 'octo-org/atlas');
  expect(screen.getByLabelText<HTMLInputElement>('Folder path').value).toBe('atlas');
  await person.selectOptions(picker, 'octo-org/other');
  expect(screen.getByLabelText<HTMLInputElement>('Folder path').value).toBe('other');
  await person.clear(screen.getByLabelText('Folder path'));
  await person.type(screen.getByLabelText('Folder path'), 'mine');
  await person.selectOptions(picker, 'octo-org/atlas');
  expect(screen.getByLabelText<HTMLInputElement>('Folder path').value).toBe('mine');
});

it('says so instead of showing an empty select when no Worker can clone', async () => {
  stubApi({});
  renderDialog([initOnly]);
  await openClone();
  expect(await screen.findByText(/No connected Worker can clone repositories/)).toBeTruthy();
  expect(screen.queryByLabelText('Atlas worker')).toBeNull();
  expect(submit().disabled).toBe(true);
});

it('offers the clone choice only with sign-in on, and keeps the other two as they were', async () => {
  const fetchStub = stubApi({ auth: 'off' });
  renderDialog([cloner]);
  await waitFor(() =>
    expect(fetchStub.mock.calls.some(([path]) => String(path).endsWith('/auth/state'))).toBe(true),
  );
  expect(screen.queryByRole('button', { name: /Clone from GitHub/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Existing repository/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /New local repository/ })).toBeTruthy();
  expect(fetchStub.mock.calls.some(([path]) => String(path).includes('/github'))).toBe(false);
});

it('explains a refused clone in plain words', async () => {
  const refusals: [number, string, RegExp][] = [
    [403, 'repository_not_accessible', /cannot reach that repository/],
    [502, 'github_unavailable', /could not reach GitHub/],
    [503, 'worker_unavailable', /cannot clone right now/],
    [400, 'invalid_relative_path', /cannot start with a dot/],
  ];
  for (const [status, code, text] of refusals) {
    stubApi({
      create: () => respond({ error: { code, message: `API said ${code}` } }, status),
    });
    renderDialog([cloner]);
    const person = await openClone();
    await person.selectOptions(await screen.findByLabelText('Repository'), 'octo-org/atlas');
    await person.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(text);
    expect(alert.textContent).not.toContain('API said');
    cleanup();
  }
});

function provisioning(project: Project) {
  wrap(<ProjectProvisioning project={project} />);
}
const pending = makeProjectFixture({
  id: 'p1',
  state: 'pending',
  operationId: 'operation:example',
  repository: { mode: 'local', workerId: 'atlas:cloner', relativePath: 'atlas', localPath: null },
});

it('tells a pending clone that it is cloning, and names the repository', async () => {
  stubApi({
    link: {
      projectId: 'p1',
      repositoryId: 11,
      fullName: 'octo-org/atlas',
      defaultBranch: 'main',
      accessible: true,
      createdAt: '2026-11-25T10:00:00.000Z',
    },
  });
  provisioning(pending);
  expect(await screen.findByText('Cloning your repository')).toBeTruthy();
  expect(screen.getByText(/cloning octo-org\/atlas/)).toBeTruthy();
});

it('keeps the initializing wording for a project without a link, and asks for none with sign-in off', async () => {
  const fetchStub = stubApi({ link: null });
  provisioning(pending);
  expect(
    await screen.findByText('Your worker is initializing the local Git repository.'),
  ).toBeTruthy();
  expect(screen.queryByText('Cloning your repository')).toBeNull();
  cleanup();

  const off = stubApi({ auth: 'off', link: null });
  provisioning(pending);
  await screen.findByText('Preparing your repository');
  await waitFor(() =>
    expect(off.mock.calls.some(([path]) => String(path).includes('/operations/'))).toBe(true),
  );
  expect(off.mock.calls.some(([path]) => String(path).includes('github-link'))).toBe(false);
  expect(fetchStub).toBeDefined();
});
