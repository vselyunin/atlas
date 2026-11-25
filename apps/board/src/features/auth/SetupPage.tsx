import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Layers3 } from 'lucide-react';
import { SetupStartResponseSchema } from '@atlas/contracts';
import type { AuthStateResponse, SetupStartResponse } from '@atlas/contracts';
import { NoContent, errorMessage, request } from '../../lib/api';
import {
  SIGN_IN_PATH,
  authKey,
  isWebUrl,
  setupFailureMessage,
  signInFailureMessage,
} from '../../lib/auth';
import type { AuthOutcome } from '../../lib/auth';

// Sends the browser to GitHub with the manifest, as GitHub's manifest flow requires: a form
// post that navigates away from the Board.
function postManifest({ action, manifest }: SetupStartResponse) {
  if (!isWebUrl(action)) {
    throw new Error(
      'Atlas could not open GitHub: the address it received is not valid. Try again.',
    );
  }
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  form.hidden = true;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = manifest;
  form.append(field);
  document.body.append(form);
  form.submit();
}

function StartStep({ outcome }: { outcome: AuthOutcome }) {
  const [organization, setOrganization] = useState('');
  const start = useMutation({
    mutationFn: () => {
      const name = organization.trim();
      return request('/setup/github/start', SetupStartResponseSchema, {
        method: 'POST',
        body: JSON.stringify(name ? { organization: name } : {}),
      });
    },
    onSuccess: postManifest,
  });
  const failure = outcome.setupFailure;
  return (
    <>
      <h1>Connect Atlas to GitHub</h1>
      <p>
        Atlas signs people in with GitHub and uses a GitHub App that you create once. Read these
        rules first, because they decide which account to use.
      </p>
      <ul className="auth-rules">
        <li>
          One Atlas works with the repositories of exactly one GitHub account, yours or an
          organization&apos;s.
        </li>
        <li>
          An App owned by a personal account cannot reach an organization&apos;s repositories. To
          use an organization&apos;s repositories, create the App under that organization, which
          needs someone allowed to create Apps there.
        </li>
        <li>
          For an organization&apos;s App, people who sign in must be members of that organization.
          For a personal App, only you can sign in.
        </li>
      </ul>
      {failure && (
        <div role="alert" className="error">
          <p>{setupFailureMessage(failure)}</p>
          {failure !== 'cancelled' && (
            <p>
              GitHub may already have created an App named like <strong>Atlas-xxxxxx</strong>.
              Delete it in your GitHub settings under Developer settings, GitHub Apps, before you
              try again.
            </p>
          )}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!start.isPending && !start.isSuccess) start.mutate();
        }}
      >
        <label>
          Organization (optional)
          <input
            value={organization}
            maxLength={39}
            pattern="[A-Za-z0-9\-]{1,39}"
            onChange={(event) => setOrganization(event.target.value)}
            placeholder="Leave empty to use your own account"
          />
        </label>
        <p className="field-note">
          GitHub asks you to confirm the App&apos;s name, and you can change it there.
        </p>
        {start.error && (
          <p role="alert" className="error">
            {errorMessage(start.error)}
          </p>
        )}
        <div className="form-actions">
          <button className="button primary" disabled={start.isPending || start.isSuccess}>
            {start.isPending || start.isSuccess ? 'Opening GitHub…' : 'Create the GitHub App'}
          </button>
        </div>
      </form>
    </>
  );
}

function OwnerStep({ app, outcome }: { app: AuthStateResponse['app']; outcome: AuthOutcome }) {
  const client = useQueryClient();
  const [code, setCode] = useState('');
  const redeem = useMutation({
    mutationFn: () =>
      request('/setup/owner-code', NoContent, {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      }),
    onSuccess: () => {
      // The code is not kept: it was sent once and the field is emptied.
      setCode('');
      void client.invalidateQueries({ queryKey: authKey });
    },
  });
  return (
    <>
      <h1>Install and sign in</h1>
      <p>
        {app ? (
          <>
            The GitHub App <strong>{app.name}</strong> belongs to <strong>{app.account}</strong>.
          </>
        ) : (
          'The GitHub App was created.'
        )}{' '}
        Install it on the repositories you want to use, then sign in. The first account to sign in
        becomes the owner.
      </p>
      {outcome.signInFailure && (
        <p role="alert" className="error">
          {signInFailureMessage(outcome.signInFailure, outcome.login)}
        </p>
      )}
      <div className="auth-actions">
        {app && isWebUrl(app.installUrl) && (
          <a className="button secondary" href={app.installUrl}>
            Install the App on GitHub
          </a>
        )}
        <a className="button primary" href={SIGN_IN_PATH}>
          Sign in with GitHub
        </a>
      </div>
      <h2>Finishing in another browser?</h2>
      <p>
        Only the browser that created the App can sign in as the owner. From another browser, enter
        the owner code. The API prints it in its terminal output when it starts. To get a new one,
        restart the API.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() && !redeem.isPending) redeem.mutate();
        }}
      >
        <label>
          Owner code
          <input
            value={code}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        {redeem.error && (
          <p role="alert" className="error">
            {errorMessage(redeem.error)}
          </p>
        )}
        {redeem.isSuccess && (
          <p role="status" className="success">
            The owner code was accepted. Now sign in with GitHub.
          </p>
        )}
        <div className="form-actions">
          <button className="button secondary" disabled={redeem.isPending || !code.trim()}>
            {redeem.isPending ? 'Checking…' : 'Use owner code'}
          </button>
        </div>
      </form>
    </>
  );
}

export function SetupPage({
  step,
  app,
  outcome,
}: {
  step: 'needed' | 'needs_owner';
  app: AuthStateResponse['app'];
  outcome: AuthOutcome;
}) {
  return (
    <main className="auth-page" aria-label="Set up Atlas">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">
            <Layers3 size={22} />
          </span>
          atlas
        </div>
        {step === 'needed' ? (
          <StartStep outcome={outcome} />
        ) : (
          <OwnerStep app={app} outcome={outcome} />
        )}
      </div>
    </main>
  );
}
