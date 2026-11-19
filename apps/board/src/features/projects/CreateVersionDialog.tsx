import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { VersionResponseSchema } from '@atlas/contracts';
import { Dialog } from '../../components/ui/dialog';
import { request, errorMessage } from '../../lib/api';

export function CreateVersionDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      request(`/projects/${projectId}/versions`, VersionResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: async ({ version }) => {
      await client.invalidateQueries({ queryKey: ['versions', projectId] });
      onCreated(version.id);
      onClose();
    },
  });
  return (
    <Dialog title="Add version" description="Keep the next milestone focused." onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!mutation.isPending) mutation.mutate();
        }}
      >
        <label>
          Version name
          <input
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="v0.2"
            disabled={mutation.isPending}
          />
        </label>
        {mutation.error && (
          <p role="alert" className="error">
            {errorMessage(mutation.error)}
          </p>
        )}
        <div className="form-actions">
          <button className="button primary" disabled={mutation.isPending || !name.trim()}>
            Add version
          </button>
        </div>
      </form>
    </Dialog>
  );
}
