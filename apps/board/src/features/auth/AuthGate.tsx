import { useState } from 'react';
import type { ReactNode } from 'react';
import { readAuthOutcome, useAuthState, useSignInRequiredRefresh } from '../../lib/auth';
import { errorMessage } from '../../lib/api';
import { SetupPage } from './SetupPage';
import { SignInPage } from './SignInPage';

// Decides what the Board shows from the API's auth state.
export function AuthGate({ children }: { children: ReactNode }) {
  useSignInRequiredRefresh();
  const auth = useAuthState();
  // Read once: the callbacks report their outcome in the address.
  const [outcome] = useState(() => readAuthOutcome(window.location.search));
  if (auth.isPending) {
    return (
      <main className="auth-page">
        <p role="status">Opening Atlas…</p>
      </main>
    );
  }
  // A failed refetch keeps the last data: the Board stays mounted rather than losing its state.
  if (auth.isError && !auth.data) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <p role="alert" className="error">
            {errorMessage(auth.error)}
          </p>
          <div className="auth-actions">
            <button className="button secondary" onClick={() => void auth.refetch()}>
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }
  const state = auth.data;
  if (!state) return null;
  if (state.auth === 'off') {
    return (
      <>
        {children}
        <p role="status" className="auth-off-notice">
          Sign-in is off. Anyone who can reach this Atlas can use it.
        </p>
      </>
    );
  }
  if (state.setup === 'needed' || state.setup === 'needs_owner') {
    return <SetupPage step={state.setup} app={state.app} outcome={outcome} />;
  }
  if (!state.user) return <SignInPage outcome={outcome} />;
  return <>{children}</>;
}
