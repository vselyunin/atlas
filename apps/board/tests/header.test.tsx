// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeProjectFixture, makeVersionFixture } from '@atlas/contracts';
import { BoardHeader } from '../src/features/layout/BoardHeader';

afterEach(cleanup);
function setup(ready = true) {
  const actions = {
    onSelectProject: vi.fn(),
    onSelectVersion: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateVersion: vi.fn(),
    onCreateTask: vi.fn(),
  };
  render(
    <BoardHeader
      projects={
        ready
          ? [
              makeProjectFixture({ id: 'p1', name: 'Alpha' }),
              makeProjectFixture({ id: 'p2', name: 'Beta' }),
            ]
          : []
      }
      projectId="p1"
      versions={
        ready
          ? [
              makeVersionFixture({ id: 'v1', name: 'v0.1' }),
              makeVersionFixture({ id: 'v2', name: 'v0.2' }),
            ]
          : []
      }
      versionId="v1"
      ready={ready}
      taskCreationDisabled={!ready}
      workerStatus="1 worker online"
      {...actions}
    />,
  );
  return actions;
}
async function open(name: string) {
  const trigger = screen.getByRole('button', { name, exact: true });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  await screen.findByRole('menu');
  return trigger;
}
it('puts creation first and selects the requested project', async () => {
  const actions = setup();
  await open('Project');
  expect(screen.getAllByRole('menuitem')[0]?.textContent).toContain('Create project');
  expect(screen.getByRole('menuitemradio', { name: 'Alpha' }).getAttribute('aria-checked')).toBe(
    'true',
  );
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Beta' }));
  expect(actions.onSelectProject).toHaveBeenCalledWith('p2');
});
it('opens creation after dismissing its project menu and restores trigger focus', async () => {
  const actions = setup();
  const trigger = await open('Project');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Create project' }));
  await waitFor(() => expect(actions.onCreateProject).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('selects a version and exposes version creation first', async () => {
  const actions = setup();
  await open('Version');
  expect(screen.getAllByRole('menuitem')[0]?.textContent).toContain('Create version');
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'v0.2' }));
  expect(actions.onSelectVersion).toHaveBeenCalledWith('v2');
  await open('Version');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Create version' }));
  await waitFor(() => expect(actions.onCreateVersion).toHaveBeenCalledTimes(1));
});
it('keeps project creation available with no ready project while disabling version and task', async () => {
  setup(false);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Version', exact: true }).disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'New task', exact: true }).disabled,
  ).toBe(true);
  await open('Project');
  expect(screen.getByRole('menuitem', { name: 'Create project' })).toBeTruthy();
});
it('dismisses a menu with Escape and returns focus', async () => {
  setup();
  const trigger = await open('Version');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
it('changes appearance from the avatar popover and closes with Escape', async () => {
  setup();
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: 'User settings' });
  await user.click(trigger);
  await user.selectOptions(screen.getByLabelText('Appearance'), 'dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(screen.getByLabelText<HTMLSelectElement>('Appearance').value).toBe('dark');
  await user.keyboard('{Escape}');
  expect(screen.queryByLabelText('Appearance')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
