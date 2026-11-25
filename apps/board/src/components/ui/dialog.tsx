import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';

export function Dialog({
  title,
  description,
  children,
  onClose,
  panel = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
  panel?: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [returnTaskId] = useState(
    () => returnFocus?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId,
  );
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content
          ref={content}
          className={panel ? 'dialog-content task-panel' : 'dialog-content'}
          onEscapeKeyDown={(event) => {
            // Escape inside the agent terminal belongs to the agent, not to the dialog.
            if (event.target instanceof Element && event.target.closest('.session-screen')) {
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => {
            const field = content.current?.querySelector<HTMLElement>(
              'input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
            );
            if (field) {
              event.preventDefault();
              field.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            const taskCard = returnTaskId
              ? Array.from(document.querySelectorAll<HTMLElement>('[data-task-id]')).find(
                  (card) => card.dataset.taskId === returnTaskId,
                )
              : undefined;
            const target = returnFocus?.isConnected
              ? returnFocus
              : (taskCard?.querySelector<HTMLElement>('.task-open') ??
                taskCard?.querySelector<HTMLElement>('.task-title') ??
                document.querySelector<HTMLElement>('.resource-trigger[aria-label="Project"]'));
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <div className="dialog-heading">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="icon-button" aria-label="Close">
              <X size={18} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
