import { API_BASE_PATH } from '@atlas/contracts';

// The App's repository rights. Not Workflows: with it the bot could change a repository's
// automation, which can read that repository's stored secrets.
export const APP_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
});

// The GitHub App manifest. No webhook section and no events (live check 2); not public; no
// account or organization rights; no user authorization during installation.
export function buildManifest(boardOrigin: string, name: string) {
  return {
    name,
    url: boardOrigin,
    redirect_url: `${boardOrigin}${API_BASE_PATH}/setup/github/callback`,
    callback_urls: [`${boardOrigin}${API_BASE_PATH}/auth/github/callback`],
    setup_url: `${boardOrigin}/?github=installed`,
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    request_oauth_on_install: false,
  };
}

// True when GitHub reports exactly the rights the manifest asked for.
export function hasExactRights(permissions: Record<string, string>) {
  const names = Object.keys(permissions);
  return (
    names.length === Object.keys(APP_PERMISSIONS).length &&
    names.every(
      (name) => Object.hasOwn(APP_PERMISSIONS, name) && APP_PERMISSIONS[name] === permissions[name],
    )
  );
}
