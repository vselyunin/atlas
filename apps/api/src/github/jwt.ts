import { sign } from 'node:crypto';
import type { AppSecrets } from './app-file.js';

// A JSON web token that authenticates as the GitHub App. GitHub accepts at most ten minutes of
// lifetime; the issue time is set back a minute to allow for clock drift.
export function appJwt(secrets: Pick<AppSecrets, 'appId' | 'privateKey'>, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iat: seconds - 60, exp: seconds + 9 * 60, iss: String(secrets.appId) });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), secrets.privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
