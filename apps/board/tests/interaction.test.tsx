// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { makeTaskFixture, makeHumanWorkerFixture, makeVersionFixture } from '@atlas/contracts';
import { TaskDetails } from '../src/features/tasks/TaskDetails';
import { CreateProjectDialog } from '../src/features/projects/CreateProjectDialog';
import { CreateTaskDialog } from '../src/features/tasks/CreateTaskDialog';

afterEach(cleanup);
function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}
it.each(['backlog', 'todo', 'working', 'done'] as const)(
  'shows the correct field locks in %s',
  (status) => {
    render(
      <QueryClientProvider client={client()}>
        <TaskDetails
          task={makeTaskFixture({ status })}
          workers={[makeHumanWorkerFixture()]}
          versions={[makeVersionFixture()]}
          onClose={() => {}}
          onMove={() => {}}
          moving={false}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Title').disabled).toBe(status !== 'backlog');
    expect(screen.getByLabelText<HTMLSelectElement>('Type').disabled).toBe(status !== 'backlog');
    expect(screen.getByLabelText<HTMLSelectElement>('Priority').disabled).toBe(
      status !== 'backlog',
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Description').disabled).toBe(
      status === 'done',
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Status').disabled).toBe(false);
  },
);
it('keeps type and priority independent in the task form', async () => {
  render(
    <QueryClientProvider client={client()}>
      <CreateTaskDialog
        projectId="p"
        versionId="v"
        workers={[makeHumanWorkerFixture()]}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Type'), 'epic');
  await user.selectOptions(screen.getByLabelText('Priority'), 'urgent');
  expect(screen.getByLabelText<HTMLSelectElement>('Type').value).toBe('epic');
  expect(screen.getByLabelText<HTMLSelectElement>('Priority').value).toBe('urgent');
  expect(screen.getByLabelText<HTMLSelectElement>('Responsible worker').value).toBe('');
});
it('disables local creation without an online worker while keeping existing mode available', async () => {
  render(
    <QueryClientProvider client={client()}>
      <CreateProjectDialog
        workers={[makeHumanWorkerFixture()]}
        onClose={() => {}}
        onCreated={() => {}}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Project name'), 'Example');
  await user.click(screen.getByRole('button', { name: /New local repository/ }));
  expect(screen.getByRole('status').textContent).toContain('No repository worker');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create project' }).disabled).toBe(
    true,
  );
  await user.click(screen.getByRole('button', { name: /Existing repository/ }));
  expect(screen.getByLabelText('Git URL')).toBeTruthy();
});
