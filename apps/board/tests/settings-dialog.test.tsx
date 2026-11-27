// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Member, User } from '@atlas/contracts';
import { SettingsDialog } from '../src/features/auth/SettingsDialog';

const owner: User = { id: 'u1', login: 'octo', name: 'Octo', avatarUrl: null, role: 'owner' };
const member: User = { id: 'u2', login: 'hubot', name: null, avatarUrl: null, role: 'member' };
const connection = {
  connection: {
    name: 'Atlas-ab12cd',
    slug: 'atlas-ab12cd',
    account: 'octo-org',
    manageUrl: 'https://github.com/organizations/octo-org/settings/apps/atlas-ab12cd',
    installUrl: 'https://github.com/apps/atlas-ab12cd/installations/new',
  },
};
const people: Member[] = [
  { id: 'u1', login: 'octo', name: 'Octo', role: 'owner', signedIn: true },
  { id: 'u2', login: 'hubot', name: null, role: 'member', signedIn: true },
];

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
function stubApi(list: Member[] = people, connectionBody: unknown = connection) {
  let items = list;
  const handle = (input: string, init?: RequestInit): Response => {
    const path = input.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    if (path === '/github/connection') return respond(connectionBody);
    if (path === '/members' && method === 'GET') return respond({ items });
    if (path === '/members' && method === 'POST') {
      const { login } = sent(init) as { login: string };
      if (items.some((item) => item.login === login)) {
        return respond(
          { error: { code: 'member_exists', message: 'This GitHub login is already a member' } },
          409,
        );
      }
      const added: Member = {
        id: `id-${login}`,
        login,
        name: null,
        role: 'member',
        signedIn: false,
      };
      items = [...items, added];
      return respond({ member: added }, 201);
    }
    if (path.startsWith('/members/') && method === 'DELETE') {
      items = items.filter((item) => item.id !== path.slice('/members/'.length));
      return new Response(null, { status: 204 });
    }
    return respond({ error: { code: 'not_found', message: 'No' } }, 404);
  };
  const fetchStub = vi.fn((input: string, init?: RequestInit) =>
    Promise.resolve(handle(input, init)),
  );
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}
function renderDialog(user: User) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsDialog user={user} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

it('lets the owner see, add and remove members', async () => {
  const fetchStub = stubApi();
  renderDialog(owner);
  expect(await screen.findByText('Atlas-ab12cd')).toBeTruthy();
  expect(screen.getByText('octo-org')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Manage the App on GitHub' }).getAttribute('href')).toBe(
    connection.connection.manageUrl,
  );
  const list = await screen.findByRole('list');
  expect(within(list).getByText('octo')).toBeTruthy();
  expect(within(list).getByText('hubot')).toBeTruthy();
  // The owner cannot be removed.
  expect(screen.queryByRole('button', { name: 'Remove octo' })).toBeNull();

  const user = userEvent.setup();
  await user.type(screen.getByLabelText('GitHub login'), 'newbie');
  await user.click(screen.getByRole('button', { name: 'Add member' }));
  expect(await within(await screen.findByRole('list')).findByText('newbie')).toBeTruthy();
  const post = fetchStub.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(sent(post?.[1])).toEqual({ login: 'newbie' });

  await user.click(screen.getByRole('button', { name: 'Remove hubot' }));
  await waitFor(() => expect(screen.queryByText('hubot')).toBeNull());
  const del = fetchStub.mock.calls.find(([, init]) => init?.method === 'DELETE');
  expect(del?.[0]).toBe('/api/v1/members/u2');
  expect(del?.[1]?.body).toBe('{}');
});

it('says when a login is already a member', async () => {
  stubApi();
  renderDialog(owner);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('GitHub login'), 'hubot');
  await user.click(screen.getByRole('button', { name: 'Add member' }));
  expect((await screen.findByRole('alert')).textContent).toContain('already a member');
});

it('shows a member the connection and no member controls', async () => {
  const fetchStub = stubApi();
  renderDialog(member);
  expect(await screen.findByText('Atlas-ab12cd')).toBeTruthy();
  expect(screen.queryByText('Members')).toBeNull();
  expect(screen.queryByLabelText('GitHub login')).toBeNull();
  expect(screen.queryByRole('button', { name: /Add member|Remove/ })).toBeNull();
  expect(fetchStub.mock.calls.some(([path]) => path.endsWith('/members'))).toBe(false);
});

it('renders no link for a manage or install address that is not a web address', async () => {
  stubApi(people, {
    connection: {
      ...connection.connection,
      manageUrl: 'javascript:alert(1)',
      installUrl: 'javascript:alert(1)',
    },
  });
  renderDialog(member);
  expect(await screen.findByText('Atlas-ab12cd')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});
