import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GithubConnectionResponseSchema,
  MemberListResponseSchema,
  MemberResponseSchema,
} from '@atlas/contracts';
import type { Member, User } from '@atlas/contracts';
import { Dialog } from '../../components/ui/dialog';
import { NoContent, errorMessage, request } from '../../lib/api';

const membersKey = ['members'] as const;

function Connection() {
  const connection = useQuery({
    queryKey: ['github', 'connection'],
    queryFn: ({ signal }) =>
      request('/github/connection', GithubConnectionResponseSchema, { signal }),
  });
  return (
    <section aria-labelledby="settings-connection">
      <h3 id="settings-connection">GitHub connection</h3>
      {connection.isPending && <p role="status">Loading the connection…</p>}
      {connection.error && (
        <p role="alert" className="error">
          {errorMessage(connection.error)}
        </p>
      )}
      {connection.data && (
        <>
          <dl className="settings-facts">
            <dt>GitHub App</dt>
            <dd>{connection.data.connection.name}</dd>
            <dt>Owning account</dt>
            <dd>{connection.data.connection.account}</dd>
          </dl>
          <p className="settings-links">
            <a href={connection.data.connection.manageUrl} target="_blank" rel="noreferrer">
              Manage the App on GitHub
            </a>
            <a href={connection.data.connection.installUrl} target="_blank" rel="noreferrer">
              Choose repositories
            </a>
          </p>
        </>
      )}
    </section>
  );
}

function Members({ currentUserId }: { currentUserId: string }) {
  const client = useQueryClient();
  const [login, setLogin] = useState('');
  const members = useQuery({
    queryKey: membersKey,
    queryFn: ({ signal }) => request('/members', MemberListResponseSchema, { signal }),
  });
  const add = useMutation({
    mutationFn: () =>
      request('/members', MemberResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ login: login.trim() }),
      }),
    onSuccess: async () => {
      setLogin('');
      await client.invalidateQueries({ queryKey: membersKey });
    },
  });
  const remove = useMutation({
    mutationFn: (member: Member) =>
      request(`/members/${member.id}`, NoContent, { method: 'DELETE', body: '{}' }),
    onSettled: () => client.invalidateQueries({ queryKey: membersKey }),
  });
  return (
    <section aria-labelledby="settings-members">
      <h3 id="settings-members">Members</h3>
      {members.isPending && <p role="status">Loading members…</p>}
      {members.error && (
        <p role="alert" className="error">
          {errorMessage(members.error)}
        </p>
      )}
      {members.data && (
        <ul className="member-list">
          {members.data.items.map((member) => (
            <li key={member.id}>
              <span>
                <strong>{member.login}</strong>
                {member.name ? ` (${member.name})` : ''}
                <span className="muted">
                  {' '}
                  {member.role === 'owner' ? 'Owner' : member.signedIn ? 'Member' : 'Invited'}
                </span>
              </span>
              {member.role !== 'owner' && member.id !== currentUserId && (
                <button
                  type="button"
                  className="button secondary"
                  aria-label={`Remove ${member.login}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(member)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {remove.error && (
        <p role="alert" className="error">
          {errorMessage(remove.error)}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (login.trim() && !add.isPending) add.mutate();
        }}
      >
        <label>
          GitHub login
          <input
            value={login}
            maxLength={39}
            pattern="[A-Za-z0-9\-]{1,39}"
            onChange={(event) => setLogin(event.target.value)}
            placeholder="octocat"
          />
        </label>
        <p className="field-note">
          They can sign in with this GitHub account. Removing a member ends their sessions.
        </p>
        {add.error && (
          <p role="alert" className="error">
            {errorMessage(add.error)}
          </p>
        )}
        <div className="form-actions">
          <button className="button primary" disabled={add.isPending || !login.trim()}>
            {add.isPending ? 'Adding…' : 'Add member'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function SettingsDialog({ user, onClose }: { user: User; onClose: () => void }) {
  return (
    <Dialog
      title="Settings"
      description="The GitHub connection and who can use Atlas."
      onClose={onClose}
    >
      <div className="settings-sections">
        <Connection />
        {user.role === 'owner' && <Members currentUserId={user.id} />}
      </div>
    </Dialog>
  );
}
