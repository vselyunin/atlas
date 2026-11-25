import { Layers3 } from 'lucide-react';
import { SIGN_IN_PATH, signInFailureMessage } from '../../lib/auth';
import type { AuthOutcome } from '../../lib/auth';

export function SignInPage({ outcome }: { outcome: AuthOutcome }) {
  return (
    <main className="auth-page" aria-label="Sign in">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">
            <Layers3 size={22} />
          </span>
          atlas
        </div>
        <h1>Sign in to Atlas</h1>
        <p>Use the GitHub account that the owner added to this Atlas.</p>
        {outcome.signInFailure && (
          <p role="alert" className="error">
            {signInFailureMessage(outcome.signInFailure, outcome.login)}
          </p>
        )}
        <div className="auth-actions">
          <a className="button primary" href={SIGN_IN_PATH}>
            Sign in with GitHub
          </a>
        </div>
      </div>
    </main>
  );
}
