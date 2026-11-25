import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { User } from '@atlas/contracts';
import { NoContent, errorMessage, request } from '../../lib/api';
import { authKey } from '../../lib/auth';
import { AppearanceRow } from '../layout/BoardHeader';
import { SettingsDialog } from './SettingsDialog';

export function UserMenu({ user }: { user: User }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const signOut = useMutation({
    mutationFn: () => request('/auth/sign-out', NoContent, { method: 'POST', body: '{}' }),
    onSuccess: async () => {
      // Nothing the previous user could see stays in memory.
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== authKey[0] });
      await client.invalidateQueries({ queryKey: authKey });
    },
  });
  const name = user.name ?? user.login;
  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className="user-avatar" aria-label="User settings">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
          ) : (
            name.slice(0, 1).toUpperCase()
          )}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="dropdown-content user-menu"
            align="end"
            sideOffset={10}
            collisionPadding={12}
            aria-label="User settings"
          >
            <div className="user-identity">
              <strong>{name}</strong>
              <span>
                {user.login} · {user.role === 'owner' ? 'Owner' : 'Member'}
              </span>
            </div>
            <div className="dropdown-separator" />
            <AppearanceRow />
            <div className="dropdown-separator" />
            <div className="user-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setOpen(false);
                  setSettings(true);
                }}
              >
                Settings
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={signOut.isPending}
                onClick={() => signOut.mutate()}
              >
                Sign out
              </button>
            </div>
            {signOut.error && (
              <p role="alert" className="error">
                {errorMessage(signOut.error)}
              </p>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {settings && <SettingsDialog user={user} onClose={() => setSettings(false)} />}
    </>
  );
}
