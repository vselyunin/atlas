// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Dialog } from '../src/components/ui/dialog';
afterEach(cleanup);
function Example({ task }: { task: boolean }) {
  const [open, setOpen] = useState(false);
  const [moved, setMoved] = useState(false);
  return (
    <>
      <button className="resource-trigger" aria-label="Project">
        Project
      </button>
      {task ? (
        <article data-task-id="task:one" key={moved ? 'working' : 'backlog'}>
          <button className="task-title" onClick={() => setOpen(true)}>
            Example task
          </button>
        </article>
      ) : (
        !moved && <button onClick={() => setOpen(true)}>First project</button>
      )}
      {open && (
        <Dialog title="Edit" description="Focus example" onClose={() => setOpen(false)}>
          <button onClick={() => setMoved(true)}>Change workspace</button>
        </Dialog>
      )}
    </>
  );
}
it('restores focus to a moved task instead of its detached original button', async () => {
  render(<Example task />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Example task' }));
  await user.click(screen.getByRole('button', { name: 'Change workspace' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Example task' }));
});
it('falls back to the stable Project control when an empty-state opener disappears', async () => {
  render(<Example task={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'First project' }));
  await user.click(screen.getByRole('button', { name: 'Change workspace' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Project' }));
});
