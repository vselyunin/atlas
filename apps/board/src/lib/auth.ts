import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AuthStateResponseSchema } from '@atlas/contracts';
import { onSignInRequired, request } from './api';

export const authKey = ['auth'] as const;

// The browser goes here to sign in. A relative link, so that it stays on the Board's origin: the
// sign-in cookie is host-only and scoped to this path.
export const SIGN_IN_PATH = '/api/v1/auth/github/start';

export function useAuthState() {
  return useQuery({
    queryKey: authKey,
    queryFn: ({ signal }) => request('/auth/state', AuthStateResponseSchema, { signal }),
  });
}

// Asks who is signed in again whenever the API says that the session has ended.
export function useSignInRequiredRefresh() {
  const client = useQueryClient();
  useEffect(() => {
    onSignInRequired(() => {
      void client.invalidateQueries({ queryKey: authKey });
    });
    return () => onSignInRequired(undefined);
  }, [client]);
}

export type AuthOutcome = {
  setupFailure?: string;
  signInFailure?: string;
  login?: string;
};

// What a setup or sign-in callback reported in the address. Read once, when the page loads.
export function readAuthOutcome(search: string): AuthOutcome {
  const query = new URLSearchParams(search);
  const reason = query.get('reason') ?? 'github_failed';
  const outcome: AuthOutcome = {};
  if (query.get('setup') === 'failed') outcome.setupFailure = reason;
  if (query.get('signin') === 'failed') {
    outcome.signInFailure = reason;
    const login = query.get('login');
    if (login) outcome.login = login;
  }
  return outcome;
}

export function setupFailureMessage(reason: string): string {
  switch (reason) {
    case 'cancelled':
      return 'Setup was cancelled on GitHub, so no App was created.';
    case 'state_invalid':
      return 'The setup link expired or was already used, or it was opened in a different browser.';
    case 'app_public':
      return 'GitHub created a public App. Atlas needs a private one, so it did not keep it.';
    case 'app_rights':
      return 'GitHub created the App with different permissions than Atlas asked for, so Atlas did not keep it.';
    default:
      return 'Atlas could not finish setting up the App with GitHub.';
  }
}

export function signInFailureMessage(reason: string, login?: string): string {
  switch (reason) {
    case 'cancelled':
      return 'Sign-in was cancelled on GitHub.';
    case 'state_invalid':
      return 'The sign-in link expired or was already used. Try signing in again.';
    case 'no_access':
      return login
        ? `The GitHub account ${login} has no access to this Atlas. Ask the owner to add you as a member, or sign in with another account.`
        : 'This GitHub account has no access to this Atlas. Ask the owner to add you as a member, or sign in with another account.';
    default:
      return 'Atlas could not sign you in with GitHub. Try again.';
  }
}
