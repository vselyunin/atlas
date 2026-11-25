// Pages on GitHub's web site that the Board links to. None of them carries a secret.

const trim = (webUrl: string) => webUrl.replace(/\/+$/, '');

// Where the owner picks the account and repositories for the App.
export function appInstallUrl(webUrl: string, slug: string) {
  return `${trim(webUrl)}/apps/${encodeURIComponent(slug)}/installations/new`;
}

// The App's settings, where its addresses and rights are changed.
export function appSettingsUrl(
  webUrl: string,
  slug: string,
  owner: { account: string; type: 'User' | 'Organization' },
) {
  const base =
    owner.type === 'Organization'
      ? `${trim(webUrl)}/organizations/${encodeURIComponent(owner.account)}`
      : trim(webUrl);
  return `${base}/settings/apps/${encodeURIComponent(slug)}`;
}

// Where the browser posts the App manifest, for a personal account or an organization.
export function newAppUrl(webUrl: string, organization: string | undefined) {
  return organization === undefined
    ? `${trim(webUrl)}/settings/apps/new`
    : `${trim(webUrl)}/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
}
